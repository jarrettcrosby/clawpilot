'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Radio from '@mui/material/Radio'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Step from '@mui/material/Step'
import StepLabel from '@mui/material/StepLabel'
import Stepper from '@mui/material/Stepper'
import Switch from '@mui/material/Switch'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CloudDoneRounded from '@mui/icons-material/CloudDoneRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import KeyRounded from '@mui/icons-material/KeyRounded'
import LinkOffRounded from '@mui/icons-material/LinkOffRounded'
import LocalShippingRounded from '@mui/icons-material/LocalShippingRounded'
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded'
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import SaveRounded from '@mui/icons-material/SaveRounded'
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded'
import VisibilityRounded from '@mui/icons-material/VisibilityRounded'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import { formatUserDateTime } from '@/lib/userDateTime'
import IntegrationSetupJourney from '@/components/settings/IntegrationSetupJourney'

type CarrierProvider = 'ups_rest' | 'fedex_rest' | 'usps_rest'
type CarrierEnvironment = 'sandbox' | 'production'

type CarrierAddress = {
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: string
}

type OperationsCarrierAccount = {
  globalId: string
  displayName: string
  senderName: string
  accountNumberLastFour: string
  registeredAddress: CarrierAddress
  addressVerification: 'unverified' | 'operator_attested' | 'provider_verified'
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
  status: 'needs_configuration' | 'active' | 'disabled'
  updatedAt: string
}

type CarrierAccountState = {
  globalId: string
  provider: CarrierProvider
  environment: CarrierEnvironment
  displayName: string
  status: 'active' | 'disabled' | 'error'
  configured: boolean
  credentialVersion: number
  clientIdLastFour: string | null
  accountNumberLastFour: string | null
  verificationStatus: 'unverified' | 'verified' | 'failed'
  verifiedAt: string | null
  lastErrorCode: string | null
  updatedAt: string
  carrierAccounts: OperationsCarrierAccount[]
}

type CarrierIntegrationsState = {
  organizationId: string
  accounts: CarrierAccountState[]
}

type CarrierPayload = {
  ok?: boolean
  error?: string
  canManage?: boolean
  canExecute?: boolean
  canReconcile?: boolean
  canRevealCredentials?: boolean
  integrations?: CarrierIntegrationsState
  rateTest?: CarrierSandboxRateTest
  rateTestLabel?: CarrierRateTestLabel
  rateTestLabels?: CarrierRateTestLabel[]
  rateTestPrinters?: CarrierRateTestPrinter[]
  printJob?: CarrierRateTestPrintJob
  rateTestAttempt?: CarrierRateTestLabelAttempt
  rateTestAttempts?: CarrierRateTestLabelAttempt[]
  credential?: RevealedCarrierCredential
}

type RevealedCarrierCredential = {
  provider: CarrierProvider
  environment: CarrierEnvironment
  clientId: string
  clientSecret: string
  credentialVersion: number
  revealedAt: string
  expiresAt: string
}

type CarrierSandboxRateTest = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  fixture: {
    origin: SandboxRateDestinationForm
    destination: SandboxRateDestinationForm
    parcel: {
      description: string
      length: number
      width: number
      height: number
      dimensionUnit: string
      weight: number
      weightUnit: string
    }
  }
  destinationFingerprint: string
  rates: Array<{
    serviceCode: string
    serviceName: string
    amount: string
    currency: string
    rateType: string | null
    transitDays: number | null
    deliveryDate: string | null
  }>
  testedAt: string
  carrierAccountGlobalId: string
  billingRelationship: 'sender' | 'recipient' | 'third_party'
  evidenceGlobalId: string
}

type SandboxRateDestinationForm = {
  name: string
  line1: string
  line2: string | null
  city: string
  region: string
  postalCode: string
  countryCode: string
}

type CarrierSandboxRate = CarrierSandboxRateTest['rates'][number]

type CarrierRateTestLabel = {
  globalId: string
  rateEvidenceGlobalId: string
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox'
  serviceCode: string
  serviceName: string
  rateType: string | null
  ratedAmount: string
  ratedCurrency: string
  trackingNumber: string
  format: 'ZPL' | 'PDF' | 'PNG'
  mediaSize: 'label_4x6' | 'label_4x8'
  byteLength: number
  contentSha256: string
  status: 'created' | 'voided'
  createdAt: string
  createdBy: string | null
  voidedAt: string | null
  voidedBy: string | null
}

type CarrierRateTestPrinter = {
  globalId: string
  warehouseGlobalId: string
  warehouseName: string
  code: string
  name: string
  connectionMode: 'local_agent' | 'browser' | 'system_service'
  supportedFormats: Array<'ZPL' | 'PDF' | 'PNG'>
  supportedMedia: Array<'label_4x6' | 'label_4x8' | 'letter' | 'a4'>
  supportedDocumentTypes: string[]
  localPrintAgentStatus: 'active' | 'revoked' | null
  status: 'online' | 'offline' | 'disabled'
}

type CarrierRateTestPrintJob = {
  globalId: string
  sourceLabelGlobalId: string | null
  status: 'queued' | 'claimed' | 'delivered' | 'failed' | 'cancelled' | 'printed' | 'rerouted'
  format: 'ZPL' | 'PDF' | 'PNG' | null
  media: 'label_4x6' | 'label_4x8' | 'letter' | 'a4' | null
  printerGlobalId: string
  printerName: string
  warehouseGlobalId: string
  warehouseName: string
  routingReason: string
  attempts: number
  maxAttempts: number
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}

type CarrierRateTestLabelAttempt = {
  globalId: string
  rateEvidenceGlobalId: string
  labelGlobalId: string | null
  action: 'create' | 'void'
  state: 'prepared' | 'succeeded' | 'failed' | 'unknown'
  provider: 'ups_rest' | 'fedex_rest'
  serviceCode: string
  selectedRate: {
    serviceCode: string
    serviceName: string
    rateType: string | null
    amount: string
    currency: string
  }
  reason: string
  errorCode: string | null
  providerReference: string | null
  reconciliationOutcome:
    | 'confirmed_no_active_label'
    | 'confirmed_voided'
    | 'confirmed_active'
    | null
  reconciliationReason: string | null
  reconciledBy: string | null
  reconciledAt: string | null
  requestedAt: string
  completedAt: string | null
  reconciliationEligible: boolean
}

type CredentialForm = {
  displayName: string
  clientId: string
  clientSecret: string
}

type CarrierAccountForm = {
  displayName: string
  senderName: string
  accountNumber: string
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  countryCode: string
  allowSenderBilling: boolean
  allowRecipientBilling: boolean
  allowThirdPartyBilling: boolean
}

const PROVIDERS: Array<{ value: CarrierProvider; label: string }> = [
  { value: 'ups_rest', label: 'UPS' },
  { value: 'fedex_rest', label: 'FedEx' },
  { value: 'usps_rest', label: 'USPS' },
]

const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '8px', backgroundColor: '#20202A' },
}

const buttonSx = {
  minHeight: 40,
  borderRadius: '8px',
  px: 1.5,
  width: { xs: '100%', sm: 'auto' },
}

function accountKey(provider: CarrierProvider, environment: CarrierEnvironment) {
  return `${provider}:${environment}`
}

function providerLabel(provider: CarrierProvider) {
  return PROVIDERS.find((entry) => entry.value === provider)?.label || provider
}

function emptyForm(provider: CarrierProvider, environment: CarrierEnvironment): CredentialForm {
  return {
    displayName: `${providerLabel(provider)} ${environment === 'sandbox' ? 'sandbox' : 'production'}`,
    clientId: '',
    clientSecret: '',
  }
}

function emptyCarrierAccountForm(): CarrierAccountForm {
  return {
    displayName: '',
    senderName: '',
    accountNumber: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode: 'US',
    allowSenderBilling: true,
    allowRecipientBilling: true,
    allowThirdPartyBilling: true,
  }
}

function defaultSandboxRateDestination(): SandboxRateDestinationForm {
  return {
    name: 'John Doe',
    line1: '101 Academy Drive',
    line2: null,
    city: 'Buzzards Bay',
    region: 'MA',
    postalCode: '02532',
    countryCode: 'US',
  }
}

function sandboxRateKey(rate: CarrierSandboxRate) {
  return JSON.stringify([
    rate.serviceCode,
    rate.serviceName,
    rate.rateType,
    rate.amount,
    rate.currency,
  ])
}

function newIdempotencyKey(action: 'create' | 'print' | 'void' | 'reconcile') {
  const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `carrier-rate-test:${action}:${unique}`
}

async function requestCarriers(init?: RequestInit): Promise<CarrierPayload> {
  const response = await fetch('/api/integrations/carriers', { cache: 'no-store', ...init })
  const result = await response.json().catch(() => ({})) as CarrierPayload
  if (!response.ok || !result.ok) throw new Error(result.error || 'Carrier integration request failed')
  return result
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Carrier integration request failed'
}

export default function CarrierIntegrationPanel() {
  const dateTimeSettings = useUserDateTime()
  const [provider, setProvider] = useState<CarrierProvider>('ups_rest')
  const [environment, setEnvironment] = useState<CarrierEnvironment>('sandbox')
  const [integrations, setIntegrations] = useState<CarrierIntegrationsState>({ organizationId: '', accounts: [] })
  const [forms, setForms] = useState<Record<string, CredentialForm>>({})
  const [carrierAccountForm, setCarrierAccountForm] = useState<CarrierAccountForm>(emptyCarrierAccountForm)
  const [editingCarrierAccountGlobalId, setEditingCarrierAccountGlobalId] = useState('')
  const [selectedCarrierAccounts, setSelectedCarrierAccounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [rateTest, setRateTest] = useState<CarrierSandboxRateTest | null>(null)
  const [rateDestinations, setRateDestinations] = useState<Record<string, SandboxRateDestinationForm>>({})
  const [rateTestLabels, setRateTestLabels] = useState<CarrierRateTestLabel[]>([])
  const [rateTestAttempts, setRateTestAttempts] = useState<CarrierRateTestLabelAttempt[]>([])
  const [rateTestPrinters, setRateTestPrinters] = useState<CarrierRateTestPrinter[]>([])
  const [selectedRateKey, setSelectedRateKey] = useState('')
  const [selectedRateTestLabelGlobalId, setSelectedRateTestLabelGlobalId] = useState('')
  const [selectedRateTestPrinterGlobalId, setSelectedRateTestPrinterGlobalId] = useState('')
  const [createLabelReason, setCreateLabelReason] = useState('')
  const [createLabelConfirmed, setCreateLabelConfirmed] = useState(false)
  const [createLabelIdempotencyKey, setCreateLabelIdempotencyKey] = useState('')
  const [printLabelIdempotencyKey, setPrintLabelIdempotencyKey] = useState('')
  const [rateTestPrintJob, setRateTestPrintJob] = useState<CarrierRateTestPrintJob | null>(null)
  const [voidLabelReason, setVoidLabelReason] = useState('')
  const [voidLabelConfirmed, setVoidLabelConfirmed] = useState(false)
  const [voidLabelIdempotencyKey, setVoidLabelIdempotencyKey] = useState('')
  const [canExecute, setCanExecute] = useState(false)
  const [canReconcile, setCanReconcile] = useState(false)
  const [reconciliationAttemptGlobalId, setReconciliationAttemptGlobalId] = useState('')
  const [reconciliationOutcome, setReconciliationOutcome] = useState('')
  const [reconciliationReason, setReconciliationReason] = useState('')
  const [reconciliationConfirmed, setReconciliationConfirmed] = useState(false)
  const [reconciliationIdempotencyKey, setReconciliationIdempotencyKey] = useState('')
  const [canRevealCredentials, setCanRevealCredentials] = useState(false)
  const [revealedCredential, setRevealedCredential] = useState<RevealedCarrierCredential | null>(null)

  const key = accountKey(provider, environment)
  const form = forms[key] || emptyForm(provider, environment)
  const account = useMemo(
    () => integrations.accounts.find((entry) => entry.provider === provider && entry.environment === environment) || null,
    [environment, integrations.accounts, provider],
  )
  const activeCarrierAccounts = useMemo(
    () => (account?.carrierAccounts || []).filter((entry) => entry.status === 'active'),
    [account?.carrierAccounts],
  )
  const explicitCarrierAccountGlobalId = selectedCarrierAccounts[key] || ''
  const selectedCarrierAccountGlobalId = activeCarrierAccounts.some(
    (entry) => entry.globalId === explicitCarrierAccountGlobalId,
  )
    ? explicitCarrierAccountGlobalId
    : activeCarrierAccounts.length === 1 ? activeCarrierAccounts[0].globalId : ''
  const selectedCarrierAccount = activeCarrierAccounts.find(
    (entry) => entry.globalId === selectedCarrierAccountGlobalId,
  ) || null
  const rateDestination = rateDestinations[key] || defaultSandboxRateDestination()
  const rateDestinationComplete = Boolean(
    rateDestination.name.trim()
    && rateDestination.line1.trim()
    && rateDestination.city.trim()
    && /^[A-Za-z]{2}$/.test(rateDestination.region.trim())
    && /^\d{5}(?:-\d{4})?$/.test(rateDestination.postalCode.trim())
    && rateDestination.countryCode === 'US',
  )
  const selectedRate = rateTest?.rates.find((entry) => sandboxRateKey(entry) === selectedRateKey) || null
  const visibleRateTestLabels = useMemo(
    () => rateTestLabels.filter(
      (entry) => entry.provider === provider && entry.environment === environment,
    ),
    [environment, provider, rateTestLabels],
  )
  const selectedRateTestLabel = visibleRateTestLabels.find(
    (entry) => entry.globalId === selectedRateTestLabelGlobalId,
  ) || null
  const visibleReconciliationAttempts = useMemo(
    () => rateTestAttempts.filter((entry) => (
      entry.provider === provider && entry.reconciliationEligible
    )),
    [provider, rateTestAttempts],
  )
  const selectedReconciliationAttempt = visibleReconciliationAttempts.find(
    (entry) => entry.globalId === reconciliationAttemptGlobalId,
  ) || null
  const compatibleRateTestPrinters = useMemo(
    () => !selectedRateTestLabel
      ? []
      : rateTestPrinters.filter((entry) => (
          entry.status === 'online'
          && entry.connectionMode === 'local_agent'
          && entry.localPrintAgentStatus === 'active'
          && entry.supportedDocumentTypes.includes('shipping_label')
          && entry.supportedFormats.includes(selectedRateTestLabel.format)
          && entry.supportedMedia.includes(selectedRateTestLabel.mediaSize)
        )),
    [rateTestPrinters, selectedRateTestLabel],
  )
  const effectiveRateTestPrinterGlobalId = compatibleRateTestPrinters.some(
    (entry) => entry.globalId === selectedRateTestPrinterGlobalId,
  )
    ? selectedRateTestPrinterGlobalId
    : compatibleRateTestPrinters.length === 1 ? compatibleRateTestPrinters[0].globalId : ''
  const selectedRateTestPrinter = compatibleRateTestPrinters.find(
    (entry) => entry.globalId === effectiveRateTestPrinterGlobalId,
  ) || null
  const labelWorkflowStep = selectedRateTestLabel?.status === 'voided'
    ? 4
    : selectedRateTestLabel
      ? rateTestPrintJob?.sourceLabelGlobalId === selectedRateTestLabel.globalId
        ? 3
        : 2
      : rateTest ? 1 : 0
  const busy = Boolean(pendingAction)
  const sandboxRateBlocker = !account?.configured
    ? 'Save and verify provider credentials first.'
    : account.verificationStatus !== 'verified'
      ? 'Verify the provider credentials first.'
      : account.status !== 'active'
        ? 'Enable this sandbox integration.'
        : !activeCarrierAccounts.length
          ? 'Add and enable a sandbox billing account with its registered address.'
          : !selectedCarrierAccountGlobalId
            ? 'Select the sandbox billing account to use for the test.'
            : ''

  useEffect(() => {
    let active = true
    requestCarriers()
      .then((result) => {
        if (!active) return
        if (result.integrations) setIntegrations(result.integrations)
        setCanRevealCredentials(result.canRevealCredentials === true)
        setCanExecute(result.canExecute === true)
        setCanReconcile(result.canReconcile === true)
        if (result.rateTestLabels) setRateTestLabels(result.rateTestLabels)
        if (result.rateTestAttempts) setRateTestAttempts(result.rateTestAttempts)
        if (result.rateTestPrinters) setRateTestPrinters(result.rateTestPrinters)
        setForms((current) => {
          const next = { ...current }
          for (const configured of result.integrations?.accounts || []) {
            const configuredKey = accountKey(configured.provider, configured.environment)
            next[configuredKey] = {
              ...(next[configuredKey] || emptyForm(configured.provider, configured.environment)),
              displayName: configured.displayName,
            }
          }
          return next
        })
      })
      .catch((loadError) => setError(errorMessage(loadError)))
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!revealedCredential) return
    const timeout = window.setTimeout(
      () => setRevealedCredential(null),
      Math.max(0, Date.parse(revealedCredential.expiresAt) - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [revealedCredential])

  function updateForm(field: keyof CredentialForm, value: string) {
    setForms((current) => ({
      ...current,
      [key]: { ...(current[key] || emptyForm(provider, environment)), [field]: value },
    }))
  }

  function updateCarrierAccountForm<K extends keyof CarrierAccountForm>(
    field: K,
    value: CarrierAccountForm[K],
  ) {
    setCarrierAccountForm((current) => ({ ...current, [field]: value }))
  }

  function updateRateDestination<K extends keyof SandboxRateDestinationForm>(
    field: K,
    value: SandboxRateDestinationForm[K],
  ) {
    setRateDestinations((current) => ({
      ...current,
      [key]: { ...(current[key] || defaultSandboxRateDestination()), [field]: value },
    }))
    setRateTest(null)
    setSelectedRateKey('')
    setCreateLabelConfirmed(false)
    setCreateLabelIdempotencyKey('')
    setRateTestPrintJob(null)
    setReconciliationAttemptGlobalId('')
    setReconciliationOutcome('')
    setReconciliationReason('')
    setReconciliationConfirmed(false)
    setReconciliationIdempotencyKey('')
  }

  function resetLoadedRate() {
    setRateTest(null)
    setSelectedRateKey('')
    setCreateLabelReason('')
    setCreateLabelConfirmed(false)
    setCreateLabelIdempotencyKey('')
    setRateTestPrintJob(null)
    setReconciliationAttemptGlobalId('')
    setReconciliationOutcome('')
    setReconciliationReason('')
    setReconciliationConfirmed(false)
    setReconciliationIdempotencyKey('')
  }

  function resetCarrierAccountForm() {
    setCarrierAccountForm(emptyCarrierAccountForm())
    setEditingCarrierAccountGlobalId('')
  }

  function editCarrierAccount(entry: OperationsCarrierAccount) {
    setEditingCarrierAccountGlobalId(entry.globalId)
    setCarrierAccountForm({
      displayName: entry.displayName,
      senderName: entry.senderName,
      accountNumber: '',
      line1: entry.registeredAddress.line1,
      line2: entry.registeredAddress.line2 || '',
      city: entry.registeredAddress.city,
      region: entry.registeredAddress.region,
      postalCode: entry.registeredAddress.postalCode,
      countryCode: entry.registeredAddress.countryCode,
      allowSenderBilling: entry.allowSenderBilling,
      allowRecipientBilling: entry.allowRecipientBilling,
      allowThirdPartyBilling: entry.allowThirdPartyBilling,
    })
  }

  async function patch(actionKey: string, body: Record<string, unknown>, success: string) {
    if (busy) return null
    setPendingAction(actionKey)
    setNotice('')
    setError('')
    try {
      const result = await requestCarriers({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (result.integrations) setIntegrations(result.integrations)
      if (result.rateTestLabels) setRateTestLabels(result.rateTestLabels)
      if (result.rateTestAttempts) setRateTestAttempts(result.rateTestAttempts)
      if (result.rateTestAttempt) {
        setRateTestAttempts((current) => {
          const remaining = current.filter(
            (entry) => entry.globalId !== result.rateTestAttempt!.globalId,
          )
          return [result.rateTestAttempt!, ...remaining]
        })
      }
      if (result.rateTestLabel) {
        setRateTestLabels((current) => {
          const remaining = current.filter((entry) => entry.globalId !== result.rateTestLabel!.globalId)
          return [result.rateTestLabel!, ...remaining]
        })
      }
      if (result.rateTestPrinters) setRateTestPrinters(result.rateTestPrinters)
      if (typeof result.canExecute === 'boolean') setCanExecute(result.canExecute)
      if (typeof result.canReconcile === 'boolean') setCanReconcile(result.canReconcile)
      setNotice(success)
      return result
    } catch (actionError) {
      setError(errorMessage(actionError))
      return null
    } finally {
      setPendingAction('')
    }
  }

  async function saveCredential(event: FormEvent) {
    event.preventDefault()
    if (!form.clientId.trim() || !form.clientSecret.trim()) return
    const result = await patch(
      'save',
      {
        action: 'update-credential',
        provider,
        environment,
        displayName: form.displayName,
        clientId: form.clientId,
        clientSecret: form.clientSecret,
      },
      `${providerLabel(provider)} credential verified and saved.`,
    )
    if (result) {
      setRevealedCredential(null)
      setForms((current) => ({
        ...current,
        [key]: { ...form, clientId: '', clientSecret: '' },
      }))
    }
  }

  async function revealCredential() {
    if (!account?.configured || busy) return
    if (!window.confirm(
      `Reveal the current ${providerLabel(provider)} ${environment} client credentials? This action is audited.`,
    )) return
    const result = await patch(
      'reveal',
      { action: 'reveal-credential', provider, environment },
      'Credentials revealed for 30 seconds.',
    )
    if (result?.credential) setRevealedCredential(result.credential)
  }

  async function copyCredential(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(`${label} copied.`)
    } catch {
      setError(`${label} could not be copied. Select the value and copy it manually.`)
    }
  }

  async function saveCarrierAccount(event: FormEvent) {
    event.preventDefault()
    if (
      !carrierAccountForm.displayName.trim()
      || !carrierAccountForm.senderName.trim()
      || (!editingCarrierAccountGlobalId && !carrierAccountForm.accountNumber.trim())
      || !carrierAccountForm.line1.trim()
      || !carrierAccountForm.city.trim()
      || !carrierAccountForm.region.trim()
      || !carrierAccountForm.postalCode.trim()
      || !carrierAccountForm.countryCode.trim()
    ) return
    const result = await patch(
      editingCarrierAccountGlobalId ? 'update-account' : 'create-account',
      {
        action: editingCarrierAccountGlobalId ? 'update-account' : 'create-account',
        provider,
        environment,
        ...(editingCarrierAccountGlobalId
          ? { carrierAccountGlobalId: editingCarrierAccountGlobalId }
          : {}),
        displayName: carrierAccountForm.displayName,
        senderName: carrierAccountForm.senderName,
        ...(carrierAccountForm.accountNumber.trim()
          ? { accountNumber: carrierAccountForm.accountNumber }
          : {}),
        registeredAddress: {
          line1: carrierAccountForm.line1,
          line2: carrierAccountForm.line2 || null,
          city: carrierAccountForm.city,
          region: carrierAccountForm.region,
          postalCode: carrierAccountForm.postalCode,
          countryCode: carrierAccountForm.countryCode,
        },
        allowSenderBilling: carrierAccountForm.allowSenderBilling,
        allowRecipientBilling: carrierAccountForm.allowRecipientBilling,
        allowThirdPartyBilling: carrierAccountForm.allowThirdPartyBilling,
      },
      editingCarrierAccountGlobalId ? 'Carrier account updated.' : 'Carrier account added.',
    )
    if (result) resetCarrierAccountForm()
  }

  async function createRateTestLabel() {
    if (!rateTest || !selectedRate || !createLabelConfirmed || !createLabelReason.trim()) return
    const idempotencyKey = createLabelIdempotencyKey || newIdempotencyKey('create')
    if (!createLabelIdempotencyKey) setCreateLabelIdempotencyKey(idempotencyKey)
    const result = await patch(
      'create-rate-test-label',
      {
        action: 'create-rate-test-label',
        rateEvidenceGlobalId: rateTest.evidenceGlobalId,
        selectedRate: {
          serviceCode: selectedRate.serviceCode,
          serviceName: selectedRate.serviceName,
          rateType: selectedRate.rateType,
          amount: selectedRate.amount,
          currency: selectedRate.currency,
        },
        destination: rateTest.fixture.destination,
        reason: createLabelReason.trim(),
        idempotencyKey,
      },
      'Sandbox label created and stored. It is now available for test printing.',
    )
    if (!result) return
    const createdLabel = result.rateTestLabel || result.rateTestLabels?.find((entry) => (
      entry.rateEvidenceGlobalId === rateTest.evidenceGlobalId
      && entry.serviceCode === selectedRate.serviceCode
      && entry.rateType === selectedRate.rateType
      && entry.ratedAmount === selectedRate.amount
      && entry.ratedCurrency === selectedRate.currency
    ))
    setSelectedRateTestLabelGlobalId(createdLabel?.globalId || '')
    setRateTestPrintJob(null)
    setCreateLabelReason('')
    setCreateLabelConfirmed(false)
    setCreateLabelIdempotencyKey('')
    setPrintLabelIdempotencyKey('')
    setVoidLabelReason('')
    setVoidLabelConfirmed(false)
    setVoidLabelIdempotencyKey('')
  }

  async function printRateTestLabel() {
    if (!selectedRateTestLabel || !selectedRateTestPrinter || selectedRateTestLabel.status !== 'created') return
    const idempotencyKey = printLabelIdempotencyKey || newIdempotencyKey('print')
    if (!printLabelIdempotencyKey) setPrintLabelIdempotencyKey(idempotencyKey)
    const result = await patch(
      'print-rate-test-label',
      {
        action: 'print-rate-test-label',
        labelGlobalId: selectedRateTestLabel.globalId,
        preferredPrinterGlobalId: selectedRateTestPrinter.globalId,
        idempotencyKey,
      },
      `Stored label ${selectedRateTestLabel.globalId} was queued for ${selectedRateTestPrinter.name}.`,
    )
    if (result) {
      setRateTestPrintJob(result.printJob || null)
      setPrintLabelIdempotencyKey('')
    }
  }

  async function voidRateTestLabel() {
    if (
      !selectedRateTestLabel
      || selectedRateTestLabel.status !== 'created'
      || !voidLabelConfirmed
      || !voidLabelReason.trim()
    ) return
    const idempotencyKey = voidLabelIdempotencyKey || newIdempotencyKey('void')
    if (!voidLabelIdempotencyKey) setVoidLabelIdempotencyKey(idempotencyKey)
    const result = await patch(
      'void-rate-test-label',
      {
        action: 'void-rate-test-label',
        labelGlobalId: selectedRateTestLabel.globalId,
        reason: voidLabelReason.trim(),
        idempotencyKey,
      },
      `Sandbox label ${selectedRateTestLabel.globalId} was voided.`,
    )
    if (!result) return
    setVoidLabelReason('')
    setVoidLabelConfirmed(false)
    setVoidLabelIdempotencyKey('')
  }

  async function reconcileRateTestAttempt() {
    if (
      !selectedReconciliationAttempt
      || !reconciliationOutcome
      || !reconciliationReason.trim()
      || !reconciliationConfirmed
    ) return
    const idempotencyKey = reconciliationIdempotencyKey
      || newIdempotencyKey('reconcile')
    if (!reconciliationIdempotencyKey) {
      setReconciliationIdempotencyKey(idempotencyKey)
    }
    const result = await patch(
      'reconcile-rate-test-attempt',
      {
        action: 'reconcile-rate-test-attempt',
        attemptGlobalId: selectedReconciliationAttempt.globalId,
        outcome: reconciliationOutcome,
        reason: reconciliationReason.trim(),
        idempotencyKey,
      },
      `Carrier attempt ${selectedReconciliationAttempt.globalId} was reconciled and its safety fence was resolved.`,
    )
    if (!result) return
    setReconciliationAttemptGlobalId('')
    setReconciliationOutcome('')
    setReconciliationReason('')
    setReconciliationConfirmed(false)
    setReconciliationIdempotencyKey('')
  }

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 320, placeItems: 'center' }}><CircularProgress size={28} /></Box>
  }

  const verifiedLabel = account?.verifiedAt
    ? formatUserDateTime(account.verifiedAt, dateTimeSettings, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

  return (
    <Box sx={{ maxWidth: 840, mx: 'auto' }}>
      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2, borderRadius: '8px' }}>{notice}</Alert> : null}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <LocalShippingRounded color="primary" />
            <Typography variant="h6" fontWeight={700}>Carrier integrations</Typography>
            <Chip
              size="small"
              color={account?.verificationStatus === 'verified' ? 'success' : account?.verificationStatus === 'failed' ? 'error' : 'default'}
              variant={account?.verificationStatus === 'verified' ? 'filled' : 'outlined'}
              label={account?.verificationStatus === 'verified' ? 'Verified' : account?.configured ? 'Needs verification' : 'Not connected'}
            />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            {verifiedLabel ? `Verified ${verifiedLabel}` : 'UPS, FedEx, and USPS direct accounts'}
          </Typography>
        </Box>
        <Tooltip title={account?.configured ? 'Enable or disable this carrier account' : 'Connect credentials first'}>
          <span>
            <FormControlLabel
              control={(
                <Switch
                  checked={account?.status === 'active'}
                  onChange={(_, enabled) => {
                    void patch(
                      'enabled',
                      { action: 'set-enabled', provider, environment, enabled },
                      enabled ? `${providerLabel(provider)} enabled.` : `${providerLabel(provider)} disabled.`,
                    )
                  }}
                  disabled={!account?.configured || busy}
                />
              )}
              label={account?.status === 'active' ? 'Active' : account?.status === 'error' ? 'Error' : 'Disabled'}
              sx={{ m: 0 }}
            />
          </span>
        </Tooltip>
      </Stack>

      <Box sx={{ mt: 2 }}>
        <IntegrationSetupJourney
          description="Scope the provider lane, verify its credential, bind a billing identity, and activate only after the safe test boundary is ready."
          steps={[
            {
              key: 'carrier-scope',
              label: 'Choose provider and environment',
              state: 'complete',
              description:
                'Provider and sandbox/production are independent credential lanes. Changing either selection updates every later setup fact.',
              facts: [
                { label: 'Provider', value: providerLabel(provider) },
                {
                  label: 'Environment',
                  value: environment === 'sandbox'
                    ? 'Sandbox / developer'
                    : 'Production',
                },
              ],
            },
            {
              key: 'carrier-credential',
              label: 'Save and verify provider credentials',
              state: account?.verificationStatus === 'verified'
                ? 'complete'
                : account?.configured
                  ? 'attention'
                  : 'current',
              description:
                'ClawPilot verifies the provider identity before the credential can be activated. Secret values remain masked unless an authorized audited reveal is requested.',
              facts: [
                {
                  label: 'ClawPilot integration ID',
                  value: account?.globalId || 'Not allocated',
                  copyable: Boolean(account?.globalId),
                },
                {
                  label: 'Stored credential',
                  value: account?.configured
                    ? `Version ${account.credentialVersion} · client ••••${
                      account.clientIdLastFour || 'unknown'
                    }`
                    : 'Not stored',
                },
                {
                  label: 'Verified',
                  value: verifiedLabel || 'Not yet',
                },
              ],
            },
            {
              key: 'carrier-billing',
              label: 'Add the carrier billing account',
              state: activeCarrierAccounts.length
                ? 'complete'
                : account?.verificationStatus === 'verified'
                  ? 'current'
                  : 'pending',
              description:
                'The account number, registered address, sender name, and payer roles are operational identity; they are separate from the API credential.',
              facts: [
                {
                  label: 'Active billing accounts',
                  value: String(activeCarrierAccounts.length),
                },
                {
                  label: 'Selected billing account',
                  value: selectedCarrierAccountGlobalId || 'Not selected',
                  copyable: Boolean(selectedCarrierAccountGlobalId),
                },
              ],
            },
            {
              key: 'carrier-activate',
              label: 'Activate and validate',
              state: account?.status === 'active'
                ? 'complete'
                : account?.verificationStatus === 'verified'
                  && activeCarrierAccounts.length
                  ? 'current'
                  : 'pending',
              description:
                'Activation is explicit. Rating stays read-only; creating, printing, and voiding a sandbox label are separate confirmed steps.',
              facts: [
                {
                  label: 'Integration status',
                  value: account?.status || 'Not connected',
                },
                {
                  label: 'Latest sandbox evidence',
                  value: rateTest?.evidenceGlobalId || 'No rate test loaded',
                  copyable: Boolean(rateTest?.evidenceGlobalId),
                },
              ],
            },
          ]}
        />
      </Box>

      <Tabs
        value={provider}
        onChange={(_, value: CarrierProvider) => {
          setProvider(value)
          setRevealedCredential(null)
          setConfirmDisconnect(false)
          resetLoadedRate()
          setSelectedRateTestLabelGlobalId('')
          setSelectedRateTestPrinterGlobalId('')
          resetCarrierAccountForm()
        }}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Carrier provider"
        sx={{ mt: 2, minHeight: 42, '& .MuiTab-root': { minHeight: 42 } }}
      >
        {PROVIDERS.map((entry) => <Tab key={entry.value} value={entry.value} label={entry.label} />)}
      </Tabs>

      <Divider sx={{ mb: 2 }} />

      <ToggleButtonGroup
        exclusive
        fullWidth
        size="small"
        value={environment}
        onChange={(_, value: CarrierEnvironment | null) => {
          if (value) {
            setEnvironment(value)
            setRevealedCredential(null)
            setConfirmDisconnect(false)
            resetLoadedRate()
            setSelectedRateTestLabelGlobalId('')
            setSelectedRateTestPrinterGlobalId('')
            resetCarrierAccountForm()
          }
        }}
        aria-label="Carrier environment"
        sx={{ maxWidth: 420, mb: 2, '& .MuiToggleButton-root': { borderRadius: '8px' } }}
      >
        <ToggleButton
          value="sandbox"
          title="Provider developer environment: UPS CIE, FedEx Sandbox, or USPS TEM"
        >
          Sandbox / developer
        </ToggleButton>
        <ToggleButton value="production">Production</ToggleButton>
      </ToggleButtonGroup>

      {account?.configured ? (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={2}>
          <Chip size="small" icon={<KeyRounded />} label={`Client ending ${account.clientIdLastFour || 'unknown'}`} />
          <Chip size="small" variant="outlined" label={`Credential v${account.credentialVersion}`} />
          <Chip size="small" variant="outlined" label={account.globalId} />
        </Stack>
      ) : null}

      {environment === 'sandbox' && provider !== 'usps_rest' && sandboxRateBlocker ? (
        <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
          <Typography variant="body2" fontWeight={700}>Sandbox rate test setup</Typography>
          <Typography variant="body2">{sandboxRateBlocker}</Typography>
          <Typography variant="caption" color="text.secondary">
            Provider credentials and carrier billing accounts are separate. The account number and its
            registered address determine sender, recipient, or third-party billing for the test request.
          </Typography>
        </Alert>
      ) : null}

      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Provider credentials</Typography>
      <Box component="form" onSubmit={saveCredential}>
        <TextField
          fullWidth
          label="Connection name"
          value={form.displayName}
          onChange={(event) => updateForm('displayName', event.target.value)}
          disabled={busy}
          sx={{ ...fieldSx, mb: 1.5 }}
          inputProps={{ maxLength: 120 }}
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
          <TextField
            required
            label="Client ID"
            value={form.clientId}
            onChange={(event) => updateForm('clientId', event.target.value)}
            disabled={busy}
            autoComplete="off"
            sx={fieldSx}
          />
          <TextField
            required
            type="password"
            label="Client secret"
            value={form.clientSecret}
            onChange={(event) => updateForm('clientSecret', event.target.value)}
            disabled={busy}
            autoComplete="new-password"
            sx={fieldSx}
          />
        </Box>
        {environment === 'sandbox' && provider !== 'usps_rest' && activeCarrierAccounts.length ? (
          <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
            <InputLabel id="sandbox-carrier-account-label">Sandbox billing account</InputLabel>
            <Select
              labelId="sandbox-carrier-account-label"
              label="Sandbox billing account"
              value={selectedCarrierAccountGlobalId}
              onChange={(event) => {
                setSelectedCarrierAccounts((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
                resetLoadedRate()
                setSelectedRateTestLabelGlobalId('')
                setSelectedRateTestPrinterGlobalId('')
              }}
              disabled={busy || activeCarrierAccounts.length === 1}
            >
              {activeCarrierAccounts.map((entry) => (
                <MenuItem key={entry.globalId} value={entry.globalId}>
                  {entry.displayName} ending {entry.accountNumberLastFour}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        ) : null}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={2} flexWrap="wrap" useFlexGap>
          <Button
            type="submit"
            variant="contained"
            startIcon={pendingAction === 'save' ? <CircularProgress size={16} color="inherit" /> : <SaveRounded />}
            disabled={busy || !form.clientId.trim() || !form.clientSecret.trim()}
            sx={buttonSx}
          >
            Save and verify
          </Button>
          <Button
            variant="outlined"
            startIcon={pendingAction === 'test' ? <CircularProgress size={16} color="inherit" /> : <CloudDoneRounded />}
            disabled={busy || !account?.configured}
            onClick={() => void patch(
              'test',
              { action: 'test-connection', provider, environment },
              `${providerLabel(provider)} connection verified.`,
            )}
            sx={buttonSx}
          >
            Test connection
          </Button>
          {canRevealCredentials ? (
            <Button
              variant="outlined"
              startIcon={pendingAction === 'reveal' ? <CircularProgress size={16} color="inherit" /> : <VisibilityRounded />}
              disabled={busy || !account?.configured}
              onClick={() => void revealCredential()}
              sx={buttonSx}
            >
              Reveal credentials
            </Button>
          ) : null}
          <Button
            color="error"
            variant="text"
            startIcon={<LinkOffRounded />}
            disabled={busy || !account?.configured}
            onClick={() => setConfirmDisconnect(true)}
            sx={buttonSx}
          >
            Disconnect
          </Button>
        </Stack>
      </Box>

      {revealedCredential
        && revealedCredential.provider === provider
        && revealedCredential.environment === environment ? (
          <Alert
            severity="warning"
            sx={{ mt: 2, borderRadius: '8px', alignItems: 'flex-start' }}
            action={(
              <Tooltip title="Hide credentials">
                <IconButton
                  color="inherit"
                  size="small"
                  onClick={() => setRevealedCredential(null)}
                  aria-label="Hide carrier credentials"
                >
                  <VisibilityOffRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          >
            <Typography variant="body2" fontWeight={700}>
              Visible for 30 seconds
            </Typography>
            <Typography variant="caption" color="inherit">
              Copy these values only to a trusted system. This reveal was recorded in organization activity.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}>
              <TextField
                label="Client ID"
                value={revealedCredential.clientId}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Copy client ID">
                        <IconButton
                          edge="end"
                          onClick={() => void copyCredential('Client ID', revealedCredential.clientId)}
                          aria-label="Copy carrier client ID"
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
                sx={fieldSx}
              />
              <TextField
                label="Client secret"
                value={revealedCredential.clientSecret}
                InputProps={{
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Copy client secret">
                        <IconButton
                          edge="end"
                          onClick={() => void copyCredential('Client secret', revealedCredential.clientSecret)}
                          aria-label="Copy carrier client secret"
                        >
                          <ContentCopyRounded fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
                sx={fieldSx}
              />
            </Box>
          </Alert>
        ) : null}

      {account?.configured ? (
        <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
          >
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>Billing accounts</Typography>
            </Box>
            {editingCarrierAccountGlobalId ? (
              <Button size="small" onClick={resetCarrierAccountForm} disabled={busy}>Cancel edit</Button>
            ) : null}
          </Stack>

          <Stack spacing={0} sx={{ mt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            {(account.carrierAccounts || []).map((entry) => (
              <Box
                key={entry.globalId}
                sx={{
                  py: 1.25,
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) auto auto' },
                  gap: 1,
                  alignItems: 'center',
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" fontWeight={650}>{entry.displayName}</Typography>
                    <Chip size="small" variant="outlined" label={`ending ${entry.accountNumberLastFour}`} />
                    <Chip size="small" variant="outlined" label={entry.globalId} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    Sender: {entry.senderName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {entry.registeredAddress.line1}, {entry.registeredAddress.city}, {entry.registeredAddress.region}{' '}
                    {entry.registeredAddress.postalCode}
                  </Typography>
                </Box>
                <FormControlLabel
                  control={(
                    <Switch
                      size="small"
                      checked={entry.status === 'active'}
                      disabled={busy || entry.status === 'needs_configuration'}
                      onChange={(_, enabled) => void patch(
                        `status-${entry.globalId}`,
                        {
                          action: 'set-account-status',
                          provider,
                          environment,
                          carrierAccountGlobalId: entry.globalId,
                          status: enabled ? 'active' : 'disabled',
                        },
                        enabled ? 'Carrier account enabled.' : 'Carrier account disabled.',
                      )}
                    />
                  )}
                  label={entry.status === 'active' ? 'Active' : 'Disabled'}
                  sx={{ m: 0 }}
                />
                <Stack direction="row" spacing={0.5}>
                  <Tooltip title="Edit carrier account">
                    <span>
                      <Button
                        size="small"
                        startIcon={<EditRounded />}
                        onClick={() => editCarrierAccount(entry)}
                        disabled={busy}
                      >
                        Edit
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Delete unused carrier account">
                    <span>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteOutlineRounded />}
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Delete ${entry.displayName}?`)) return
                          void patch(
                            `delete-${entry.globalId}`,
                            {
                              action: 'delete-account',
                              provider,
                              environment,
                              carrierAccountGlobalId: entry.globalId,
                            },
                            'Carrier account deleted.',
                          )
                        }}
                      >
                        Delete
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              </Box>
            ))}
          </Stack>

          <Box component="form" onSubmit={saveCarrierAccount} sx={{ mt: 2 }}>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
              {editingCarrierAccountGlobalId ? 'Edit billing account' : 'Add billing account'}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
              <TextField
                required
                label="Account name"
                value={carrierAccountForm.displayName}
                onChange={(event) => updateCarrierAccountForm('displayName', event.target.value)}
                disabled={busy}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              <TextField
                required={!editingCarrierAccountGlobalId}
                label={editingCarrierAccountGlobalId ? 'New account number (optional)' : 'Account number'}
                value={carrierAccountForm.accountNumber}
                onChange={(event) => updateCarrierAccountForm('accountNumber', event.target.value)}
                disabled={busy}
                autoComplete="off"
                sx={fieldSx}
              />
              <TextField
                required
                label="Sender name"
                value={carrierAccountForm.senderName}
                onChange={(event) => updateCarrierAccountForm('senderName', event.target.value)}
                disabled={busy}
                inputProps={{ maxLength: 120 }}
                helperText="Used as the shipper name for carrier rating and labels."
                sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
              />
              <TextField
                required
                label="Registered address line 1"
                value={carrierAccountForm.line1}
                onChange={(event) => updateCarrierAccountForm('line1', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                label="Registered address line 2"
                value={carrierAccountForm.line2}
                onChange={(event) => updateCarrierAccountForm('line2', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="City"
                value={carrierAccountForm.city}
                onChange={(event) => updateCarrierAccountForm('city', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="State / region"
                value={carrierAccountForm.region}
                onChange={(event) => updateCarrierAccountForm('region', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="Postal code"
                value={carrierAccountForm.postalCode}
                onChange={(event) => updateCarrierAccountForm('postalCode', event.target.value)}
                disabled={busy}
                sx={fieldSx}
              />
              <TextField
                required
                label="Country code"
                value={carrierAccountForm.countryCode}
                onChange={(event) => updateCarrierAccountForm('countryCode', event.target.value.toUpperCase())}
                disabled={busy}
                inputProps={{ maxLength: 2 }}
                sx={fieldSx}
              />
            </Box>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mt={1}>
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowSenderBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowSenderBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Sender"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowRecipientBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowRecipientBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Recipient"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowThirdPartyBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowThirdPartyBilling', value)}
                    disabled={busy}
                  />
                )}
                label="Third party"
              />
            </Stack>
            <Button
              type="submit"
              variant="outlined"
              startIcon={<AddRounded />}
              disabled={busy}
              sx={buttonSx}
            >
              {editingCarrierAccountGlobalId ? 'Save account' : 'Add account'}
            </Button>
          </Box>
        </Box>
      ) : null}

      {environment === 'sandbox' && provider !== 'usps_rest' ? (
        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" fontWeight={700}>Sandbox label test workflow</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Rate an editable US destination, choose one exact returned service, create a sandbox label,
            print its stored bytes, and void it when the test is complete.
          </Typography>
          <Stepper
            activeStep={labelWorkflowStep}
            alternativeLabel
            sx={{ mt: 2, mb: 2, '& .MuiStepLabel-label': { fontSize: '0.75rem' } }}
          >
            {['Rate', 'Create label', 'Print stored label', 'Void'].map((label) => (
              <Step key={label}><StepLabel>{label}</StepLabel></Step>
            ))}
          </Stepper>
          {!canExecute ? (
            <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
              You can review and run rating diagnostics, but creating, printing, or voiding a label also
              requires warehouse-execution permission.
            </Alert>
          ) : null}
          <Typography variant="overline" color="text.disabled">Step 1 · Rate</Typography>
          <Box
            sx={{
              mt: 1.5,
              p: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '8px',
              backgroundColor: 'rgba(255,255,255,0.02)',
            }}
          >
            <Typography variant="caption" color="text.disabled">Read-only sender</Typography>
            {selectedCarrierAccount ? (
              <>
                <Typography variant="body2" fontWeight={650}>{selectedCarrierAccount.senderName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {selectedCarrierAccount.registeredAddress.line1}
                  {selectedCarrierAccount.registeredAddress.line2
                    ? `, ${selectedCarrierAccount.registeredAddress.line2}`
                    : ''}
                  , {selectedCarrierAccount.registeredAddress.city}, {selectedCarrierAccount.registeredAddress.region}{' '}
                  {selectedCarrierAccount.registeredAddress.postalCode}{' '}
                  {selectedCarrierAccount.registeredAddress.countryCode}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Select an active sandbox billing account.
              </Typography>
            )}
          </Box>
          <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 2, mb: 1 }}>
            Test destination
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
            <TextField
              required
              label="Recipient name"
              value={rateDestination.name}
              onChange={(event) => updateRateDestination('name', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 120 }}
              sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
            />
            <TextField
              required
              label="Destination address line 1"
              value={rateDestination.line1}
              onChange={(event) => updateRateDestination('line1', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 160 }}
              sx={fieldSx}
            />
            <TextField
              label="Destination address line 2"
              value={rateDestination.line2 || ''}
              onChange={(event) => updateRateDestination('line2', event.target.value || null)}
              disabled={busy}
              inputProps={{ maxLength: 120 }}
              sx={fieldSx}
            />
            <TextField
              required
              label="Destination city"
              value={rateDestination.city}
              onChange={(event) => updateRateDestination('city', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 100 }}
              sx={fieldSx}
            />
            <TextField
              required
              label="Destination state"
              value={rateDestination.region}
              onChange={(event) => updateRateDestination('region', event.target.value.toUpperCase())}
              disabled={busy}
              inputProps={{ maxLength: 2 }}
              helperText="Two-letter US state code"
              sx={fieldSx}
            />
            <TextField
              required
              label="Destination ZIP code"
              value={rateDestination.postalCode}
              onChange={(event) => updateRateDestination('postalCode', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 10 }}
              sx={fieldSx}
            />
            <TextField
              label="Destination country"
              value={rateDestination.countryCode}
              inputProps={{ readOnly: true }}
              helperText="Sandbox rating is currently US-only"
              sx={fieldSx}
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Fixed parcel: Test Product, 12 x 10 x 6 IN, 5 LB.
          </Typography>
          <Typography variant="caption" color="text.disabled">
            Rating returns prices only. No label media, shipment, pickup, manifest, tracking record, print
            job, or carrier charge is created. Enter test data; durable evidence retains address fingerprints,
            not the entered name or street.
          </Typography>
          <Box sx={{ mt: 1.5 }}>
            <Tooltip title={
              sandboxRateBlocker
              || (!rateDestinationComplete
                ? 'Complete the US test destination first.'
                : 'Returns sandbox prices for the entered destination and fixed test parcel.')
            }>
              <span>
                <Button
                  variant="outlined"
                  startIcon={pendingAction === 'rate'
                    ? <CircularProgress size={16} color="inherit" />
                    : <PriceCheckRounded />}
                  disabled={busy || Boolean(sandboxRateBlocker) || !rateDestinationComplete}
                  onClick={() => {
                    void patch(
                      'rate',
                      {
                        action: 'test-sandbox-rate',
                        provider,
                        environment,
                        destination: rateDestination,
                        ...(activeCarrierAccounts.length > 1
                          ? { carrierAccountGlobalId: selectedCarrierAccountGlobalId }
                          : {}),
                      },
                      `${providerLabel(provider)} sandbox rates returned. Select one exact rate to continue.`,
                    ).then((result) => {
                      if (!result?.rateTest) return
                      setRateTest(result.rateTest)
                      setSelectedRateKey('')
                      setSelectedRateTestLabelGlobalId('')
                      setRateTestPrintJob(null)
                      setCreateLabelReason('')
                      setCreateLabelConfirmed(false)
                      setCreateLabelIdempotencyKey('')
                      setRateDestinations((current) => ({
                        ...current,
                        [key]: result.rateTest!.fixture.destination,
                      }))
                    })
                  }}
                  sx={buttonSx}
                >
                  Test sandbox rates
                </Button>
              </span>
            </Tooltip>
          </Box>
          {rateTest ? (
            <Stack spacing={0} sx={{ mt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
              {rateTest.rates.map((rate) => (
                <Box
                  component="label"
                  key={sandboxRateKey(rate)}
                  sx={{
                    py: 1.25,
                    display: 'grid',
                    gridTemplateColumns: { xs: 'auto 1fr auto', sm: 'auto minmax(180px, 1fr) auto auto' },
                    gap: 1,
                    alignItems: 'center',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    cursor: 'pointer',
                    backgroundColor: selectedRateKey === sandboxRateKey(rate)
                      ? 'rgba(99, 102, 241, 0.08)'
                      : 'transparent',
                  }}
                >
                  <Radio
                    size="small"
                    checked={selectedRateKey === sandboxRateKey(rate)}
                    onChange={() => {
                      setSelectedRateKey(sandboxRateKey(rate))
                      setCreateLabelConfirmed(false)
                      setCreateLabelIdempotencyKey('')
                    }}
                    disabled={busy}
                    inputProps={{ 'aria-label': `Select ${rate.serviceName} ${rate.amount} ${rate.currency}` }}
                  />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={650} noWrap>{rate.serviceName}</Typography>
                    <Typography variant="caption" color="text.disabled">
                      {rate.serviceCode}{rate.rateType ? ` · ${rate.rateType}` : ''}
                    </Typography>
                  </Box>
                  <Typography variant="body2" fontWeight={700}>{rate.currency} {rate.amount}</Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ gridColumn: { xs: '2 / -1', sm: 'auto' }, textAlign: { sm: 'right' } }}
                  >
                    {rate.deliveryDate || (rate.transitDays !== null ? `${rate.transitDays} business days` : 'Transit estimate unavailable')}
                  </Typography>
                </Box>
              ))}
              <Typography variant="caption" color="text.disabled" sx={{ mt: 1 }}>
                {rateTest.carrierAccountGlobalId} | {rateTest.billingRelationship.replace('_', ' ')} | Evidence{' '}
                {rateTest.evidenceGlobalId}
              </Typography>
            </Stack>
          ) : null}

          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="overline" color="text.disabled">Step 2 · Create label</Typography>
            <Typography variant="subtitle2" fontWeight={700}>Confirm one exact returned rate</Typography>
            {!rateTest ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Run a sandbox rate first. Label creation is not available from an advisory service name or a
                manually entered price.
              </Typography>
            ) : !selectedRate ? (
              <Alert severity="info" sx={{ mt: 1.5, borderRadius: '8px' }}>
                Select one rate returned by evidence {rateTest.evidenceGlobalId} to continue.
              </Alert>
            ) : (
              <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                <Box
                  sx={{
                    p: 1.5,
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(255,255,255,0.02)',
                  }}
                >
                  <Typography variant="body2" fontWeight={700}>{selectedRate.serviceName}</Typography>
                  <Typography variant="body2">
                    {selectedRate.currency} {selectedRate.amount}
                    {' · '}{selectedRate.serviceCode}
                    {selectedRate.rateType ? ` · ${selectedRate.rateType}` : ''}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    Exact source evidence: {rateTest.evidenceGlobalId}
                  </Typography>
                </Box>
                <TextField
                  required
                  multiline
                  minRows={2}
                  label="Test-label reason"
                  value={createLabelReason}
                  onChange={(event) => {
                    setCreateLabelReason(event.target.value)
                    setCreateLabelIdempotencyKey('')
                  }}
                  disabled={busy}
                  inputProps={{ maxLength: 500 }}
                  helperText={`${createLabelReason.length}/500 · recorded with the carrier action`}
                  sx={fieldSx}
                />
                <FormControlLabel
                  control={(
                    <Checkbox
                      checked={createLabelConfirmed}
                      onChange={(_, checked) => {
                        setCreateLabelConfirmed(checked)
                        setCreateLabelIdempotencyKey('')
                      }}
                      disabled={busy}
                    />
                  )}
                  label={`I confirm this will call ${providerLabel(provider)} sandbox to create and durably store a real test label for the exact selected rate.`}
                  sx={{ alignItems: 'flex-start', m: 0 }}
                />
                <Box>
                  <Button
                    variant="contained"
                    startIcon={pendingAction === 'create-rate-test-label'
                      ? <CircularProgress size={16} color="inherit" />
                      : <LocalShippingRounded />}
                    disabled={
                      busy
                      || !canExecute
                      || !createLabelConfirmed
                      || !createLabelReason.trim()
                    }
                    onClick={() => void createRateTestLabel()}
                    sx={buttonSx}
                  >
                    Create and store sandbox label
                  </Button>
                </Box>
              </Stack>
            )}
          </Box>

          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="overline" color="text.disabled">Stored test labels</Typography>
            <Typography variant="subtitle2" fontWeight={700}>Reloadable label history</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              Label metadata is durable and safe to review. Label bytes and internal database identifiers
              are never returned to this page.
            </Typography>
            {visibleRateTestLabels.length ? (
              <Stack spacing={1} sx={{ mt: 1.5 }}>
                {visibleRateTestLabels.map((label) => {
                  const selected = selectedRateTestLabel?.globalId === label.globalId
                  return (
                    <Button
                      key={label.globalId}
                      variant={selected ? 'outlined' : 'text'}
                      color="inherit"
                      fullWidth
                      onClick={() => {
                        setSelectedRateTestLabelGlobalId(label.globalId)
                        setRateTestPrintJob(null)
                        setSelectedRateTestPrinterGlobalId('')
                        setPrintLabelIdempotencyKey('')
                        setVoidLabelReason('')
                        setVoidLabelConfirmed(false)
                        setVoidLabelIdempotencyKey('')
                      }}
                      sx={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        borderRadius: '8px',
                        p: 1.25,
                        textTransform: 'none',
                      }}
                    >
                      <Box sx={{ width: '100%', minWidth: 0 }}>
                        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body2" fontWeight={700}>{label.serviceName}</Typography>
                          <Chip
                            size="small"
                            color={label.status === 'created' ? 'success' : 'default'}
                            variant="outlined"
                            label={label.status === 'created' ? 'Created' : 'Voided'}
                          />
                          <Chip size="small" variant="outlined" label={label.globalId} />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block">
                          Tracking {label.trackingNumber} · {label.ratedCurrency} {label.ratedAmount} ·{' '}
                          {label.format} {label.mediaSize.replace('label_', '').replace('x', ' × ')}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          Created {formatUserDateTime(label.createdAt, dateTimeSettings, {
                            year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                          })} · Evidence {label.rateEvidenceGlobalId}
                        </Typography>
                      </Box>
                    </Button>
                  )
                })}
              </Stack>
            ) : (
              <Alert severity="info" sx={{ mt: 1.5, borderRadius: '8px' }}>
                No {providerLabel(provider)} sandbox test labels have been stored for this organization.
              </Alert>
            )}
          </Box>

          {visibleReconciliationAttempts.length ? (
            <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="overline" color="warning.main">Recovery · Carrier reconciliation</Typography>
              <Typography variant="subtitle2" fontWeight={700}>
                Resolve an uncertain carrier mutation
              </Typography>
              <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>
                Check the carrier developer portal first. This action records the verified carrier-side
                outcome and clears the retry safety fence; it does not make another carrier API call.
              </Alert>
              <Stack spacing={1} sx={{ mt: 1.5 }}>
                {visibleReconciliationAttempts.map((attempt) => (
                  <Button
                    key={attempt.globalId}
                    variant={
                      reconciliationAttemptGlobalId === attempt.globalId
                        ? 'outlined'
                        : 'text'
                    }
                    color="inherit"
                    fullWidth
                    onClick={() => {
                      setReconciliationAttemptGlobalId(attempt.globalId)
                      setReconciliationOutcome('')
                      setReconciliationReason('')
                      setReconciliationConfirmed(false)
                      setReconciliationIdempotencyKey('')
                    }}
                    sx={{
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      borderRadius: '8px',
                      p: 1.25,
                      textTransform: 'none',
                    }}
                  >
                    <Box>
                      <Typography variant="body2" fontWeight={700}>
                        {attempt.action === 'create' ? 'Create label' : 'Void label'} · {attempt.globalId}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block">
                        {attempt.state} · {attempt.selectedRate.serviceName} · Evidence{' '}
                        {attempt.rateEvidenceGlobalId}
                      </Typography>
                      <Typography variant="caption" color="text.disabled" display="block">
                        {attempt.errorCode || 'Prepared attempt exceeded the two-minute execution window'}
                      </Typography>
                    </Box>
                  </Button>
                ))}
              </Stack>
              {selectedReconciliationAttempt ? (
                <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                  {!canReconcile ? (
                    <Alert severity="info" sx={{ borderRadius: '8px' }}>
                      Organization admin and warehouse-execution permissions are required to record a
                      reconciliation outcome.
                    </Alert>
                  ) : null}
                  <FormControl fullWidth size="small">
                    <InputLabel id="rate-test-reconciliation-outcome-label">
                      Carrier-verified outcome
                    </InputLabel>
                    <Select
                      labelId="rate-test-reconciliation-outcome-label"
                      label="Carrier-verified outcome"
                      value={reconciliationOutcome}
                      onChange={(event) => {
                        setReconciliationOutcome(event.target.value)
                        setReconciliationConfirmed(false)
                        setReconciliationIdempotencyKey('')
                      }}
                      disabled={busy || !canReconcile}
                    >
                      {selectedReconciliationAttempt.action === 'create' ? (
                        <MenuItem value="confirmed_no_active_label">
                          No active label exists at carrier
                        </MenuItem>
                      ) : [
                        <MenuItem key="confirmed_voided" value="confirmed_voided">
                          Carrier confirms label is voided
                        </MenuItem>,
                        <MenuItem key="confirmed_active" value="confirmed_active">
                          Carrier confirms label is still active
                        </MenuItem>,
                      ]}
                    </Select>
                  </FormControl>
                  <TextField
                    required
                    multiline
                    minRows={2}
                    label="Reconciliation evidence note"
                    value={reconciliationReason}
                    onChange={(event) => {
                      setReconciliationReason(event.target.value)
                      setReconciliationIdempotencyKey('')
                    }}
                    disabled={busy || !canReconcile}
                    inputProps={{ maxLength: 500 }}
                    helperText="Record where and when you verified the carrier-side outcome."
                    sx={fieldSx}
                  />
                  <FormControlLabel
                    control={(
                      <Checkbox
                        checked={reconciliationConfirmed}
                        onChange={(_, checked) => {
                          setReconciliationConfirmed(checked)
                          setReconciliationIdempotencyKey('')
                        }}
                        disabled={busy || !canReconcile}
                      />
                    )}
                    label={`I verified the carrier-side outcome for exactly ${selectedReconciliationAttempt.globalId}.`}
                    sx={{ alignItems: 'flex-start', m: 0 }}
                  />
                  <Box>
                    <Button
                      color="warning"
                      variant="outlined"
                      disabled={
                        busy
                        || !canReconcile
                        || !reconciliationOutcome
                        || !reconciliationReason.trim()
                        || !reconciliationConfirmed
                      }
                      onClick={() => void reconcileRateTestAttempt()}
                      sx={buttonSx}
                    >
                      Record outcome and clear safety fence
                    </Button>
                  </Box>
                </Stack>
              ) : null}
            </Box>
          ) : null}

          {selectedRateTestLabel ? (
            <>
              <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="overline" color="text.disabled">Step 3 · Print stored label</Typography>
                <Typography variant="subtitle2" fontWeight={700}>
                  Route {selectedRateTestLabel.globalId} to a compatible printer
                </Typography>
                <Alert severity="info" sx={{ mt: 1.5, borderRadius: '8px' }}>
                  Printing queues the label bytes already stored in ClawPilot. It does not call the carrier,
                  buy postage, create another label, or change the tracking number.
                </Alert>
                <Box
                  sx={{
                    mt: 1.5,
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                    gap: 1,
                  }}
                >
                  <Typography variant="body2">
                    <strong>Tracking:</strong> {selectedRateTestLabel.trackingNumber}
                  </Typography>
                  <Typography variant="body2">
                    <strong>Media:</strong> {selectedRateTestLabel.format} · {selectedRateTestLabel.mediaSize}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" sx={{ gridColumn: { sm: '1 / -1' } }}>
                    Stored bytes: {selectedRateTestLabel.byteLength.toLocaleString()} · SHA-256{' '}
                    {selectedRateTestLabel.contentSha256.slice(0, 16)}…
                  </Typography>
                </Box>
                {selectedRateTestLabel.status === 'voided' ? (
                  <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>
                    This label is voided and cannot be queued for a new test print.
                  </Alert>
                ) : compatibleRateTestPrinters.length ? (
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    <FormControl fullWidth size="small">
                      <InputLabel id="rate-test-printer-label">Compatible printer</InputLabel>
                      <Select
                        labelId="rate-test-printer-label"
                        label="Compatible printer"
                        value={effectiveRateTestPrinterGlobalId}
                        onChange={(event) => {
                          setSelectedRateTestPrinterGlobalId(event.target.value)
                          setPrintLabelIdempotencyKey('')
                        }}
                        disabled={busy}
                      >
                        {compatibleRateTestPrinters.map((entry) => (
                          <MenuItem key={entry.globalId} value={entry.globalId}>
                            {entry.name} · {entry.warehouseName} · {entry.connectionMode.replace('_', ' ')}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Box>
                      <Button
                        variant="contained"
                        startIcon={pendingAction === 'print-rate-test-label'
                          ? <CircularProgress size={16} color="inherit" />
                          : <PrintRounded />}
                        disabled={busy || !canExecute || !selectedRateTestPrinter}
                        onClick={() => void printRateTestLabel()}
                        sx={buttonSx}
                      >
                        Test print stored label
                      </Button>
                    </Box>
                    {rateTestPrintJob?.sourceLabelGlobalId === selectedRateTestLabel.globalId ? (
                      <Alert
                        severity={rateTestPrintJob.status === 'failed' ? 'warning' : 'success'}
                        sx={{ borderRadius: '8px' }}
                      >
                        Print job {rateTestPrintJob.globalId} is {rateTestPrintJob.status} for{' '}
                        {rateTestPrintJob.printerName}. Retry and controlled reprint remain available in
                        Operations print jobs and reuse the same stored label bytes.
                      </Alert>
                    ) : null}
                  </Stack>
                ) : (
                  <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>
                    No online local-agent printer supports shipping labels in {selectedRateTestLabel.format}{' '}
                    on {selectedRateTestLabel.mediaSize}.{' '}
                    {selectedRateTestLabel.format === 'PDF'
                      ? 'This existing provider PDF remains immutable. Void it below, run a new sandbox rate, and create a new provider-native thermal ZPL label for a ZPL printer; or configure a PDF-capable local print service.'
                      : 'Configure a printer that explicitly supports this exact format and media before printing.'}
                  </Alert>
                )}
              </Box>

              <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="overline" color="text.disabled">Step 4 · Void</Typography>
                <Typography variant="subtitle2" fontWeight={700}>Close the carrier-side test</Typography>
                {selectedRateTestLabel.status === 'voided' ? (
                  <Alert severity="success" sx={{ mt: 1.5, borderRadius: '8px' }}>
                    Voided {selectedRateTestLabel.voidedAt
                      ? formatUserDateTime(selectedRateTestLabel.voidedAt, dateTimeSettings, {
                          year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                        })
                      : 'successfully'}.
                  </Alert>
                ) : (
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                      Voiding calls the carrier for tracking {selectedRateTestLabel.trackingNumber}. It does
                      not delete the stored audit record.
                    </Alert>
                    <TextField
                      required
                      multiline
                      minRows={2}
                      label="Void reason"
                      value={voidLabelReason}
                      onChange={(event) => {
                        setVoidLabelReason(event.target.value)
                        setVoidLabelIdempotencyKey('')
                      }}
                      disabled={busy}
                      inputProps={{ maxLength: 500 }}
                      helperText={`${voidLabelReason.length}/500 · recorded with the carrier void`}
                      sx={fieldSx}
                    />
                    <FormControlLabel
                      control={(
                        <Checkbox
                          checked={voidLabelConfirmed}
                          onChange={(_, checked) => {
                            setVoidLabelConfirmed(checked)
                            setVoidLabelIdempotencyKey('')
                          }}
                          disabled={busy}
                        />
                      )}
                      label={`I confirm I want to void exactly ${selectedRateTestLabel.globalId}, tracking ${selectedRateTestLabel.trackingNumber}.`}
                      sx={{ alignItems: 'flex-start', m: 0 }}
                    />
                    <Box>
                      <Button
                        color="error"
                        variant="outlined"
                        startIcon={pendingAction === 'void-rate-test-label'
                          ? <CircularProgress size={16} color="inherit" />
                          : <DeleteOutlineRounded />}
                        disabled={
                          busy
                          || !canExecute
                          || !voidLabelConfirmed
                          || !voidLabelReason.trim()
                        }
                        onClick={() => void voidRateTestLabel()}
                        sx={buttonSx}
                      >
                        Void exact sandbox label
                      </Button>
                    </Box>
                  </Stack>
                )}
              </Box>
            </>
          ) : null}
        </Box>
      ) : null}

      {confirmDisconnect ? (
        <Alert
          severity="warning"
          sx={{ mt: 2, borderRadius: '8px' }}
          action={(
            <Stack direction="row" spacing={0.5}>
              <Button color="inherit" size="small" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
              <Button
                color="error"
                size="small"
                startIcon={<PowerSettingsNewRounded />}
                onClick={() => {
                  setConfirmDisconnect(false)
                  setRevealedCredential(null)
                  void patch(
                    'disconnect',
                    { action: 'disconnect', provider, environment },
                    `${providerLabel(provider)} credential disconnected.`,
                  )
                }}
              >
                Confirm
              </Button>
            </Stack>
          )}
        >
          Remove the encrypted credential for this account?
        </Alert>
      ) : null}
    </Box>
  )
}
