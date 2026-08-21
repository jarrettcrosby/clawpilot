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
import DownloadRounded from '@mui/icons-material/DownloadRounded'
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
import { useMeasurementSystem } from '@/components/measurements/MeasurementSystemProvider'
import { useUserDateTime } from '@/components/timezone/UserDateTimeProvider'
import {
  formatDimensionsMm,
  formatGrams,
  GRAMS_PER_POUND,
  MILLIMETERS_PER_INCH,
} from '@/lib/measurements'
import { formatUserDateTime } from '@/lib/userDateTime'
import IntegrationSetupJourney from '@/components/settings/IntegrationSetupJourney'
import BrokeredTransportIntegrationPanel from '@/components/settings/BrokeredTransportIntegrationPanel'
import {
  isSourceManagedCarrierConfiguration,
  managedCarrierDelegationProfile,
} from '@/lib/integrations/carrierManagedDelegation'

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
  allowedCapabilities: string[]
  authorizationScope: string | null
  credentialRevealAllowed: boolean
  managedBy: string | null
  senderOriginWarehouseGlobalId: string | null
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
  productionLabelAuthorizationAllowed?: boolean
  productionLabelRuntimeLane?: 'production' | 'railway_development' | null
  integrations?: CarrierIntegrationsState
  rateTest?: CarrierShippingDiagnosticRateTest
  rateTestLabel?: CarrierRateTestLabel
  rateTestLabels?: CarrierRateTestLabel[]
  rateTestLabelOutputs?: Record<
    'ups_rest' | 'fedex_rest',
    CarrierRateTestLabelOutputOption[]
  >
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

type DiagnosticRateParcel = {
  description: string
  length: number
  width: number
  height: number
  dimensionUnit: 'IN'
  weight: number
  weightUnit: 'LB'
}

type CarrierShippingDiagnosticRateTest = {
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox' | 'production'
  fixture: {
    origin: SandboxRateDestinationForm
    destination: SandboxRateDestinationForm & { residential?: boolean }
    parcel: DiagnosticRateParcel
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

type CarrierSandboxRate = CarrierShippingDiagnosticRateTest['rates'][number]

type CarrierRateTestLabel = {
  globalId: string
  rateEvidenceGlobalId: string
  carrierAccountGlobalId: string
  provider: 'ups_rest' | 'fedex_rest'
  environment: 'sandbox' | 'production'
  serviceCode: string
  serviceName: string
  rateType: string | null
  ratedAmount: string
  ratedCurrency: string
  trackingNumber: string
  lifecycleMode: 'carrier_void' | 'close_sample'
  format: 'ZPL' | 'PDF' | 'PNG'
  mediaSize: 'label_4x6' | 'label_4x8'
  sourceKind: 'provider_native'
  providerImageType: 'ZPL' | 'ZPLII' | 'PDF' | 'PNG'
  providerStockType: 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6'
  byteLength: number
  contentSha256: string
  printArtifactGlobalId: string | null
  status: 'created' | 'voided'
  createdAt: string
  createdBy: string | null
  voidedAt: string | null
  voidedBy: string | null
}

type CarrierRateTestLabelOutputOption = {
  format: 'ZPL' | 'PDF' | 'PNG'
  mediaSize: 'label_4x6'
  sourceKind: 'provider_native'
  providerImageType: 'ZPL' | 'ZPLII' | 'PDF' | 'PNG'
  providerStockType: 'HEIGHT_6_WIDTH_4' | 'STOCK_4X6' | 'PAPER_4X6'
}

const FALLBACK_RATE_TEST_LABEL_OUTPUTS: Record<
  'ups_rest' | 'fedex_rest',
  CarrierRateTestLabelOutputOption[]
> = {
  ups_rest: [{
    format: 'ZPL',
    mediaSize: 'label_4x6',
    sourceKind: 'provider_native',
    providerImageType: 'ZPL',
    providerStockType: 'HEIGHT_6_WIDTH_4',
  }],
  fedex_rest: [
    {
      format: 'ZPL',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'ZPLII',
      providerStockType: 'STOCK_4X6',
    },
    {
      format: 'PDF',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'PDF',
      providerStockType: 'PAPER_4X6',
    },
    {
      format: 'PNG',
      mediaSize: 'label_4x6',
      sourceKind: 'provider_native',
      providerImageType: 'PNG',
      providerStockType: 'PAPER_4X6',
    },
  ],
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
  artifactGlobalId: string | null
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
  environment: 'sandbox' | 'production'
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
  providerErrorCodes: string[]
  providerHttpStatus: number | null
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
  minHeight: 44,
  borderRadius: '8px',
  px: 1.5,
  width: { xs: '100%', sm: 'auto' },
}

const iconActionSx = { minWidth: 44, minHeight: 44 }

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

function defaultDiagnosticParcel(): DiagnosticRateParcel {
  return {
    description: 'Test Product',
    length: 12,
    width: 10,
    height: 6,
    dimensionUnit: 'IN',
    weight: 5,
    weightUnit: 'LB',
  }
}

function productionPostageConfirmation(input: {
  provider: 'ups_rest' | 'fedex_rest'
  carrierAccountGlobalId: string
  serviceCode: string
  currency: string
  amount: string
}) {
  return `BUY REAL POSTAGE | ${input.provider === 'ups_rest' ? 'UPS' : 'FEDEX'} | ${input.carrierAccountGlobalId} | ${input.serviceCode} | ${input.currency} ${input.amount}`
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

export default function CarrierIntegrationPanel({
  brokeredFocus = 'all',
}: {
  brokeredFocus?: 'small_parcel' | 'all'
}) {
  const dateTimeSettings = useUserDateTime()
  const { measurementSystem } = useMeasurementSystem()
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
  const [rateTest, setRateTest] = useState<CarrierShippingDiagnosticRateTest | null>(null)
  const [rateDestinations, setRateDestinations] = useState<Record<string, SandboxRateDestinationForm>>({})
  const [rateParcels, setRateParcels] = useState<Record<string, DiagnosticRateParcel>>({})
  const [rateDestinationResidential, setRateDestinationResidential] = useState<Record<string, boolean>>({})
  const [diagnosticSenderPhones, setDiagnosticSenderPhones] = useState<Record<string, string>>({})
  const [diagnosticRecipientPhones, setDiagnosticRecipientPhones] = useState<Record<string, string>>({})
  const [productionPostageTypedConfirmation, setProductionPostageTypedConfirmation] = useState('')
  const [rateTestLabels, setRateTestLabels] = useState<CarrierRateTestLabel[]>([])
  const [rateTestLabelOutputs, setRateTestLabelOutputs] = useState(
    FALLBACK_RATE_TEST_LABEL_OUTPUTS,
  )
  const [selectedLabelOutputFormats, setSelectedLabelOutputFormats] = useState<
    Record<'ups_rest' | 'fedex_rest', 'ZPL' | 'PDF' | 'PNG'>
  >({ ups_rest: 'ZPL', fedex_rest: 'ZPL' })
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
  const [productionLabelAuthorizationAllowed, setProductionLabelAuthorizationAllowed] =
    useState(false)
  const [productionLabelRuntimeLane, setProductionLabelRuntimeLane] = useState<
    'production' | 'railway_development' | null
  >(null)
  const [revealedCredential, setRevealedCredential] = useState<RevealedCarrierCredential | null>(null)
  const [livePostageReason, setLivePostageReason] = useState('')
  const [livePostageConfirmation, setLivePostageConfirmation] = useState('')

  const key = accountKey(provider, environment)
  const form = forms[key] || emptyForm(provider, environment)
  const account = useMemo(
    () => integrations.accounts.find((entry) => entry.provider === provider && entry.environment === environment) || null,
    [environment, integrations.accounts, provider],
  )
  const livePostageAuthorized = account?.allowedCapabilities.includes(
    'production_label',
  ) === true
  const activeCarrierAccounts = useMemo(
    () => (account?.carrierAccounts || []).filter((entry) => entry.status === 'active'),
    [account?.carrierAccounts],
  )
  const productionSenderAccounts = activeCarrierAccounts.filter(
    (entry) => entry.allowSenderBilling,
  )
  const diagnosticCarrierAccounts = environment === 'production'
    ? productionSenderAccounts
    : activeCarrierAccounts
  const carrierConfiguration = account ? {
    managedBy: account.managedBy,
    authorizationScope: account.authorizationScope,
    credentialRevealAllowed: account.credentialRevealAllowed,
    senderOriginWarehouseGlobalId: account.senderOriginWarehouseGlobalId,
    allowedCapabilities: account.allowedCapabilities,
  } : null
  const sourceManagedDelegation = carrierConfiguration
    ? isSourceManagedCarrierConfiguration(carrierConfiguration)
    : false
  const delegationProfile = carrierConfiguration
    ? managedCarrierDelegationProfile(carrierConfiguration)
    : null
  const ratingOnlyDelegation = delegationProfile === 'rating_only'
  const managedSandboxFulfillmentDelegation =
    delegationProfile === 'sandbox_fulfillment_diagnostic'
  const managedDelegationDrift = delegationProfile === 'drifted'
  const labelWorkflowAuthorized =
    !sourceManagedDelegation || managedSandboxFulfillmentDelegation
  const explicitCarrierAccountGlobalId = selectedCarrierAccounts[key] || ''
  const selectedCarrierAccountGlobalId = diagnosticCarrierAccounts.some(
    (entry) => entry.globalId === explicitCarrierAccountGlobalId,
  )
    ? explicitCarrierAccountGlobalId
    : diagnosticCarrierAccounts.length === 1
      ? diagnosticCarrierAccounts[0].globalId
      : ''
  const selectedCarrierAccount = diagnosticCarrierAccounts.find(
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
  const providerRateParcel = rateParcels[key] || defaultDiagnosticParcel()
  const destinationResidential = rateDestinationResidential[key] === true
  const diagnosticSenderPhone = diagnosticSenderPhones[key] || ''
  const diagnosticRecipientPhone = diagnosticRecipientPhones[key] || ''
  const diagnosticPhonesComplete = Boolean(
    diagnosticSenderPhone.trim().length >= 7 && diagnosticRecipientPhone.trim().length >= 7,
  )
  const diagnosticParcelComplete = Boolean(
    providerRateParcel.description.trim()
    && providerRateParcel.length > 0
    && providerRateParcel.width > 0
    && providerRateParcel.height > 0
    && providerRateParcel.weight > 0,
  )
  const selectedUnitRateParcelDimensions = formatDimensionsMm({
    lengthMm: providerRateParcel.length * MILLIMETERS_PER_INCH,
    widthMm: providerRateParcel.width * MILLIMETERS_PER_INCH,
    heightMm: providerRateParcel.height * MILLIMETERS_PER_INCH,
  }, measurementSystem, { maximumFractionDigits: 2 })
  const selectedUnitRateParcelWeight = formatGrams(
    providerRateParcel.weight * GRAMS_PER_POUND,
    measurementSystem,
    { maximumFractionDigits: 2 },
  )
  const selectedRate = rateTest?.rates.find((entry) => sandboxRateKey(entry) === selectedRateKey) || null
  const labelOutputProvider = provider === 'fedex_rest' ? 'fedex_rest' : 'ups_rest'
  const availableLabelOutputs = provider === 'usps_rest'
    ? []
    : rateTestLabelOutputs[labelOutputProvider]
  const selectedLabelOutputFormat = selectedLabelOutputFormats[labelOutputProvider]
  const selectedLabelOutput = availableLabelOutputs.find(
    (entry) => entry.format === selectedLabelOutputFormat,
  ) || availableLabelOutputs[0] || null
  const selectedOutputCompatiblePrinters = useMemo(
    () => !selectedLabelOutput
      ? []
      : rateTestPrinters.filter((entry) => (
          entry.status === 'online'
          && entry.connectionMode === 'local_agent'
          && entry.localPrintAgentStatus === 'active'
          && entry.supportedDocumentTypes.includes('shipping_label')
          && entry.supportedFormats.includes(selectedLabelOutput.format)
          && entry.supportedMedia.includes(selectedLabelOutput.mediaSize)
        )),
    [rateTestPrinters, selectedLabelOutput],
  )
  const visibleRateTestLabels = useMemo(
    () => rateTestLabels.filter(
      (entry) => entry.provider === provider && entry.environment === environment,
    ),
    [environment, provider, rateTestLabels],
  )
  const selectedRateTestLabel = visibleRateTestLabels.find(
    (entry) => entry.globalId === selectedRateTestLabelGlobalId,
  ) || null
  const selectedRateTestLabelVoidAttempt = rateTestAttempts.find((entry) => (
    entry.labelGlobalId === selectedRateTestLabel?.globalId
    && entry.action === 'void'
  )) || null
  const selectedRateTestLabelClosedWithoutCarrierVoid = Boolean(
    selectedRateTestLabel?.status === 'voided'
    && selectedRateTestLabelVoidAttempt?.reconciliationOutcome === 'confirmed_no_active_label',
  )
  const visibleReconciliationAttempts = useMemo(
    () => rateTestAttempts.filter((entry) => (
      entry.provider === provider
      && entry.environment === environment
      && entry.reconciliationEligible
    )),
    [environment, provider, rateTestAttempts],
  )
  const selectedReconciliationAttempt = visibleReconciliationAttempts.find(
    (entry) => entry.globalId === reconciliationAttemptGlobalId,
  ) || null
  const exactCapabilityRateTestPrinters = useMemo(
    () => !selectedRateTestLabel
      ? []
      : rateTestPrinters.filter((entry) => (
          entry.supportedDocumentTypes.includes('shipping_label')
          && entry.supportedFormats.includes(selectedRateTestLabel.format)
          && entry.supportedMedia.includes(selectedRateTestLabel.mediaSize)
        )),
    [rateTestPrinters, selectedRateTestLabel],
  )
  const onlineExactCapabilityRateTestPrinters = useMemo(
    () => exactCapabilityRateTestPrinters.filter((entry) => entry.status === 'online'),
    [exactCapabilityRateTestPrinters],
  )
  const compatibleRateTestPrinters = useMemo(
    () => onlineExactCapabilityRateTestPrinters.filter((entry) => (
      entry.connectionMode === 'local_agent'
      && entry.localPrintAgentStatus === 'active'
    )),
    [onlineExactCapabilityRateTestPrinters],
  )
  const effectiveRateTestPrinterGlobalId = compatibleRateTestPrinters.some(
    (entry) => entry.globalId === selectedRateTestPrinterGlobalId,
  )
    ? selectedRateTestPrinterGlobalId
    : compatibleRateTestPrinters.length === 1 ? compatibleRateTestPrinters[0].globalId : ''
  const selectedRateTestPrinter = compatibleRateTestPrinters.find(
    (entry) => entry.globalId === effectiveRateTestPrinterGlobalId,
  ) || null
  const printReadinessBlocker = !selectedRateTestLabel
    ? 'label_required'
    : !canExecute
      ? 'execution_permission_required'
      : selectedRateTestLabel.status === 'voided'
        ? 'label_voided'
        : !rateTestPrinters.length
          ? 'printer_profile_required'
          : !exactCapabilityRateTestPrinters.length
            ? 'exact_printer_capability_required'
            : !onlineExactCapabilityRateTestPrinters.length
              ? 'compatible_printer_offline'
              : !compatibleRateTestPrinters.length
                ? 'active_local_agent_required'
                : !selectedRateTestPrinter
                  ? 'printer_selection_required'
                  : null
  const testPrintEligible = printReadinessBlocker === null
  const labelWorkflowStep = selectedRateTestLabel?.status === 'voided'
    ? 4
    : selectedRateTestLabel
      ? rateTestPrintJob?.sourceLabelGlobalId === selectedRateTestLabel.globalId
        ? 3
        : 2
      : rateTest ? 1 : 0
  const busy = Boolean(pendingAction)
  const sandboxRateBlocker = managedDelegationDrift
    ? 'This managed sandbox-rating connection is inconsistent and must be repaired by the platform operator.'
    : !account?.configured
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
  const productionRateBlocker = !account?.configured
    ? 'Save and verify the production credential first.'
    : account.verificationStatus !== 'verified'
      ? 'Verify the production credential first.'
      : account.status !== 'active'
        ? 'Enable the production connection first.'
        : !account.allowedCapabilities.includes('production_rate')
          ? 'This connection is not authorized for production rating.'
          : !productionSenderAccounts.length
            ? 'Add and enable a production sender-billing account.'
            : !selectedCarrierAccountGlobalId
              ? 'Select the exact production sender-billing account to rate.'
              : !selectedCarrierAccount?.allowSenderBilling
                ? 'Select a production account authorized for sender billing.'
                : ''
  const productionRateReady = !productionRateBlocker
  const selectedProductionConfirmation = rateTest?.environment === 'production' && selectedRate
    ? productionPostageConfirmation({
        provider: rateTest.provider,
        carrierAccountGlobalId: rateTest.carrierAccountGlobalId,
        serviceCode: selectedRate.serviceCode,
        currency: selectedRate.currency,
        amount: selectedRate.amount,
      })
    : ''
  const productionCreateBlocker = environment !== 'production'
    ? ''
    : !productionLabelAuthorizationAllowed
      ? 'LIVE label buying is available only in the trusted ClawPilot Railway development or production runtime.'
      : !livePostageAuthorized
        ? 'Authorize the production_label capability above before buying REAL POSTAGE.'
        : !canRevealCredentials
          ? 'Organization owner or administrator access is required to buy REAL POSTAGE.'
          : !canExecute
            ? 'Warehouse execution permission is required to buy REAL POSTAGE.'
            : !diagnosticPhonesComplete
              ? 'Enter sender and recipient phone numbers for the provider label request.'
              : ''

  useEffect(() => {
    let active = true
    requestCarriers()
      .then((result) => {
        if (!active) return
        if (result.integrations) setIntegrations(result.integrations)
        setCanRevealCredentials(result.canRevealCredentials === true)
        setProductionLabelAuthorizationAllowed(
          result.productionLabelAuthorizationAllowed === true,
        )
        setProductionLabelRuntimeLane(result.productionLabelRuntimeLane || null)
        setCanExecute(result.canExecute === true)
        setCanReconcile(result.canReconcile === true)
        if (result.rateTestLabels) setRateTestLabels(result.rateTestLabels)
        if (result.rateTestLabelOutputs) {
          setRateTestLabelOutputs(result.rateTestLabelOutputs)
        }
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
    setProductionPostageTypedConfirmation('')
  }

  function updateRateParcel<K extends keyof DiagnosticRateParcel>(
    field: K,
    value: DiagnosticRateParcel[K],
  ) {
    setRateParcels((current) => ({
      ...current,
      [key]: { ...(current[key] || defaultDiagnosticParcel()), [field]: value },
    }))
    resetLoadedRate()
  }

  function updateDestinationResidential(value: boolean) {
    setRateDestinationResidential((current) => ({ ...current, [key]: value }))
    resetLoadedRate()
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
    setProductionPostageTypedConfirmation('')
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
        ...(!editingCarrierAccountGlobalId && carrierAccountForm.accountNumber.trim()
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
    if (
      !rateTest
      || !selectedRate
      || !selectedLabelOutput
      || (environment === 'sandbox' && !createLabelConfirmed)
      || (
        environment === 'production'
        && productionPostageTypedConfirmation !== selectedProductionConfirmation
      )
      || !createLabelReason.trim()
    ) return
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
        destination: {
          name: rateTest.fixture.destination.name,
          line1: rateTest.fixture.destination.line1,
          line2: rateTest.fixture.destination.line2,
          city: rateTest.fixture.destination.city,
          region: rateTest.fixture.destination.region,
          postalCode: rateTest.fixture.destination.postalCode,
          countryCode: rateTest.fixture.destination.countryCode,
        },
        destinationResidential: rateTest.fixture.destination.residential === true,
        parcel: rateTest.fixture.parcel,
        ...(environment === 'production'
          ? {
              shipFromPhone: diagnosticSenderPhone.trim(),
              shipToPhone: diagnosticRecipientPhone.trim(),
              operatorConfirmation: productionPostageTypedConfirmation,
            }
          : {}),
        outputFormat: selectedLabelOutput.format,
        reason: createLabelReason.trim(),
        idempotencyKey,
      },
      environment === 'production'
        ? 'LIVE production postage was created and stored. Print the stored provider bytes, then void it immediately.'
        : 'Sandbox label created and stored. It is now available for test printing.',
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
    setProductionPostageTypedConfirmation('')
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
    const closeSample = selectedRateTestLabel.lifecycleMode === 'close_sample'
    const result = await patch(
      closeSample ? 'close-rate-test-sample-label' : 'void-rate-test-label',
      {
        action: closeSample
          ? 'close-rate-test-sample-label'
          : 'void-rate-test-label',
        labelGlobalId: selectedRateTestLabel.globalId,
        reason: voidLabelReason.trim(),
        idempotencyKey,
      },
      closeSample
        ? `UPS CIE sample ${selectedRateTestLabel.globalId} was closed locally; no carrier void call was made.`
        : `${selectedRateTestLabel.environment === 'production' ? 'LIVE production' : 'Sandbox'} label ${selectedRateTestLabel.globalId} was voided.`,
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
            <Typography variant="h6" fontWeight={700}>
              {brokeredFocus === 'small_parcel'
                ? 'Small Parcel direct accounts'
                : 'Carrier integrations'}
            </Typography>
            <Chip
              size="small"
              color={account?.verificationStatus === 'verified' ? 'success' : account?.verificationStatus === 'failed' ? 'error' : 'default'}
              variant={account?.verificationStatus === 'verified' ? 'filled' : 'outlined'}
              label={account?.verificationStatus === 'verified' ? 'Verified' : account?.configured ? 'Needs verification' : 'Not connected'}
            />
          </Stack>
          <Typography variant="caption" color="text.disabled">
            {verifiedLabel
              ? `Verified ${verifiedLabel}`
              : brokeredFocus === 'small_parcel'
                ? 'UPS and FedEx power Create Shipment; existing USPS credential administration remains available but is not executable there.'
                : 'UPS, FedEx, and USPS direct accounts'}
          </Typography>
        </Box>
        <Tooltip
          title={sourceManagedDelegation
            ? 'This rating lane is activated and maintained by EPISCS'
            : account?.configured
              ? 'Enable or disable this carrier account'
              : 'Connect credentials first'}
        >
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
                  disabled={!account?.configured || busy || sourceManagedDelegation}
                />
              )}
              label={account?.status === 'active' ? 'Active' : account?.status === 'error' ? 'Error' : 'Disabled'}
              sx={{ m: 0 }}
            />
          </span>
        </Tooltip>
      </Stack>

      <Box sx={{ mt: 2 }}>
        {ratingOnlyDelegation ? (
          <IntegrationSetupJourney
            description="The sandbox rating lane is already provisioned. Confirm the managed sender identity, then run a quote from the AG Alchemy warehouse."
            steps={[
              {
                key: 'carrier-delegation-ready',
                label: 'Managed rating lane is ready',
                state: 'complete',
                description:
                  'EPISCS owns and verifies the sandbox credential. ClawPilot holds a separately encrypted AG-scoped projection that cannot be revealed or changed here.',
                facts: [
                  { label: 'Provider', value: providerLabel(provider) },
                  {
                    label: 'ClawPilot integration ID',
                    value: account?.globalId || 'Not allocated',
                    copyable: Boolean(account?.globalId),
                  },
                  {
                    label: 'Sender warehouse',
                    value: account?.senderOriginWarehouseGlobalId || 'Not bound',
                    copyable: Boolean(account?.senderOriginWarehouseGlobalId),
                  },
                  { label: 'Authorized capability', value: 'Sandbox rating only' },
                ],
              },
              {
                key: 'carrier-delegation-rate',
                label: 'Run a sandbox rate check',
                state: rateTest?.provider === provider ? 'complete' : 'current',
                description:
                  'Edit the destination and request a quote. This writes redacted ClawPilot evidence only; it cannot create a label, shipment, pickup, manifest, or provider mutation.',
                facts: [
                  {
                    label: 'Latest sandbox evidence',
                    value: rateTest?.provider === provider
                      ? rateTest.evidenceGlobalId
                      : 'No rate test loaded',
                    copyable: rateTest?.provider === provider,
                  },
                ],
              },
            ]}
          />
        ) : managedSandboxFulfillmentDelegation ? (
          <IntegrationSetupJourney
            description="The EPISCS-managed sandbox diagnostic lane is ready. Rate a destination, create one sandbox label from an exact returned rate, then download or test-print the stored bytes and void the sample."
            steps={[
              {
                key: 'carrier-delegation-ready',
                label: 'Managed sandbox diagnostics are ready',
                state: 'complete',
                description:
                  'EPISCS owns and verifies the credential. ClawPilot keeps the AG-scoped projection encrypted and never reveals or changes its credential or billing identity here.',
                facts: [
                  { label: 'Provider', value: providerLabel(provider) },
                  {
                    label: 'ClawPilot integration ID',
                    value: account?.globalId || 'Not allocated',
                    copyable: Boolean(account?.globalId),
                  },
                  {
                    label: 'Sender warehouse',
                    value: account?.senderOriginWarehouseGlobalId || 'Not bound',
                    copyable: Boolean(account?.senderOriginWarehouseGlobalId),
                  },
                  { label: 'Authorized capability', value: 'Sandbox rate and label diagnostics' },
                ],
              },
              {
                key: 'carrier-delegation-rate',
                label: 'Rate the test parcel',
                state: rateTest?.provider === provider ? 'complete' : 'current',
                description:
                  'Edit the destination and request sandbox prices. Select one exact returned service before label creation.',
              },
              {
                key: 'carrier-delegation-label',
                label: 'Create and inspect one sandbox label',
                state: selectedRateTestLabel ? 'complete' : rateTest ? 'current' : 'pending',
                description:
                  'Create one provider sandbox sample, then download its stored PDF, PNG, or ZPL bytes or route those same bytes to a compatible test printer.',
                facts: [{
                  label: 'Stored sample label',
                  value: selectedRateTestLabel?.globalId || 'Not created',
                  copyable: Boolean(selectedRateTestLabel?.globalId),
                }],
              },
              {
                key: 'carrier-delegation-close',
                label: 'Void or close the sample',
                state: selectedRateTestLabel?.status === 'voided'
                  ? 'complete'
                  : selectedRateTestLabel ? 'current' : 'pending',
                description:
                  'Void a real provider sandbox sample. UPS CIE samples, which never become provider shipments, are explicitly closed in ClawPilot instead.',
              },
            ]}
          />
        ) : (
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
        )}
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
        sx={{ mt: 2, minHeight: 44, '& .MuiTab-root': { minHeight: 44 } }}
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
        sx={{
          maxWidth: 420,
          mb: 2,
          '& .MuiToggleButton-root': { borderRadius: '8px', minHeight: 44 },
        }}
      >
        <ToggleButton
          value="sandbox"
          title="Provider developer environment: UPS CIE, FedEx Sandbox, or USPS TEM"
        >
          Sandbox / developer
        </ToggleButton>
        <ToggleButton value="production">Production</ToggleButton>
      </ToggleButtonGroup>

      {account?.configured && !sourceManagedDelegation ? (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={2}>
          <Chip size="small" icon={<KeyRounded />} label={`Client ending ${account.clientIdLastFour || 'unknown'}`} />
          <Chip size="small" variant="outlined" label={`Credential v${account.credentialVersion}`} />
          <Chip size="small" variant="outlined" label={account.globalId} />
        </Stack>
      ) : null}

      {ratingOnlyDelegation ? (
        <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
          <Typography variant="body2" fontWeight={700}>
            EPISCS-managed sandbox rating
          </Typography>
          <Typography variant="body2">
            This connection can request sandbox rates only. Its sender is the AG Alchemy warehouse{' '}
            {account?.senderOriginWarehouseGlobalId || ''}. Credentials, billing identity, labels, voids,
            pickups, and manifests remain source-managed and cannot be changed or revealed here.
          </Typography>
        </Alert>
      ) : null}

      {managedSandboxFulfillmentDelegation ? (
        <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
          <Typography variant="body2" fontWeight={700}>
            EPISCS-managed sandbox fulfillment diagnostics
          </Typography>
          <Typography variant="body2">
            This connection can request sandbox rates and create, download, test-print, and void sandbox
            sample labels. Credentials and the full billing identity remain concealed. Production labels,
            pickups, manifests, and shipments are not authorized.
          </Typography>
        </Alert>
      ) : null}

      {managedDelegationDrift ? (
        <Alert severity="error" sx={{ mb: 2, borderRadius: '8px' }}>
          <Typography variant="body2" fontWeight={700}>
            Managed sandbox delegation needs repair
          </Typography>
          <Typography variant="body2">
            The EPISCS-managed connection no longer matches its approved AG Alchemy warehouse,
            scope, capability set, or no-reveal policy. Rating and all carrier-management actions are disabled
            until the platform operator restores the exact delegated configuration.
          </Typography>
        </Alert>
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

      {environment === 'production' && provider !== 'usps_rest' && account ? (
        <Box
          sx={{
            mb: 2,
            p: 1.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '8px',
          }}
        >
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle2" fontWeight={700} sx={{ mr: 0.5 }}>
              Production capabilities
            </Typography>
            <Chip
              size="small"
              color={productionRateReady ? 'success' : 'default'}
              variant={productionRateReady ? 'filled' : 'outlined'}
              label={productionRateReady ? 'Rate-only ready' : 'Rate setup incomplete'}
            />
            <Chip
              size="small"
              color={productionLabelAuthorizationAllowed && livePostageAuthorized ? 'warning' : 'default'}
              variant="outlined"
              label={productionLabelAuthorizationAllowed
                ? livePostageAuthorized
                  ? productionLabelRuntimeLane === 'railway_development'
                    ? 'Railway dev live postage authorized'
                    : 'Live postage authorized'
                  : productionLabelRuntimeLane === 'railway_development'
                    ? 'Railway dev live postage off'
                    : 'Live postage off'
                : 'Live postage unavailable in this runtime'}
            />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {productionRateReady
              ? 'Production rating is ready. Test it from a completely packed order through the sealed, read-only rerate flow; a quote cannot create a label or shipment.'
              : productionRateBlocker}
          </Typography>
          {!productionLabelAuthorizationAllowed ? (
            <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 0.5 }}>
              Production labels can be authorized only in production or the trusted Railway development
              service. Vercel previews and local/browser-only runtimes remain blocked.
              {livePostageAuthorized
                ? ' A stored authorization is ignored here and can only be revoked below.'
                : ''}
            </Typography>
          ) : null}
          {productionLabelRuntimeLane === 'railway_development' ? (
            <Alert severity="warning" sx={{ mt: 1, borderRadius: '8px' }}>
              <Typography variant="caption">
                Railway development uses the selected production UPS or FedEx connection. A successful
                whole-shipment purchase creates real production postage and may incur charges. Use only an
                approved packed test order, then void the complete group through ClawPilot.
              </Typography>
            </Alert>
          ) : null}
          {canRevealCredentials
          && (productionLabelAuthorizationAllowed || livePostageAuthorized) ? (
            <Stack spacing={1.25} sx={{ mt: 1.5 }}>
              <TextField
                size="small"
                label={livePostageAuthorized ? 'Revocation reason' : 'Authorization reason'}
                value={livePostageReason}
                onChange={(event) => setLivePostageReason(event.target.value)}
                inputProps={{ maxLength: 500 }}
                disabled={busy}
                sx={fieldSx}
              />
              {productionLabelAuthorizationAllowed && !livePostageAuthorized ? (
                <TextField
                  size="small"
                  label="Type AUTHORIZE LIVE POSTAGE"
                  value={livePostageConfirmation}
                  onChange={(event) => setLivePostageConfirmation(event.target.value)}
                  disabled={busy}
                  sx={fieldSx}
                />
              ) : null}
              <Button
                color={livePostageAuthorized ? 'warning' : 'error'}
                variant="outlined"
                disabled={
                  busy
                  || livePostageReason.trim().length < 3
                  || (!livePostageAuthorized
                    && (!productionLabelAuthorizationAllowed
                      || livePostageConfirmation !== 'AUTHORIZE LIVE POSTAGE'))
                }
                onClick={() => {
                  void patch(
                    'live-postage',
                    {
                      action: 'set-production-label-enabled',
                      provider,
                      enabled: !livePostageAuthorized,
                      reason: livePostageReason,
                      confirmation: livePostageAuthorized
                        ? ''
                        : livePostageConfirmation,
                    },
                    livePostageAuthorized
                      ? 'Live postage authorization revoked.'
                      : 'Live postage authorization enabled for this production carrier.',
                  ).then((result) => {
                    if (!result) return
                    setLivePostageReason('')
                    setLivePostageConfirmation('')
                  })
                }}
                sx={buttonSx}
              >
                {livePostageAuthorized
                  ? 'Revoke live postage'
                  : 'Authorize live postage'}
              </Button>
            </Stack>
          ) : productionLabelAuthorizationAllowed ? (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              An organization owner or administrator with Operations activation permission must change live-postage authorization.
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {!sourceManagedDelegation ? (
        <>
          <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Provider credentials</Typography>
          <Box component="form" onSubmit={saveCredential}>
        <TextField
          fullWidth
          label="Connection name"
          value={form.displayName}
          onChange={(event) => updateForm('displayName', event.target.value)}
          disabled={busy || ratingOnlyDelegation}
          sx={{ ...fieldSx, mb: 1.5 }}
          inputProps={{ maxLength: 120 }}
        />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
          <TextField
            required
            label="Client ID"
            value={form.clientId}
            onChange={(event) => updateForm('clientId', event.target.value)}
            disabled={busy || ratingOnlyDelegation}
            autoComplete="off"
            sx={fieldSx}
          />
          <TextField
            required
            type="password"
            label="Client secret"
            value={form.clientSecret}
            onChange={(event) => updateForm('clientSecret', event.target.value)}
            disabled={busy || ratingOnlyDelegation}
            autoComplete="new-password"
            sx={fieldSx}
          />
        </Box>
        {provider !== 'usps_rest' && diagnosticCarrierAccounts.length ? (
          <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
            <InputLabel id="carrier-account-label">
              {environment === 'production'
                ? 'LIVE production billing account'
                : 'Sandbox billing account'}
            </InputLabel>
            <Select
              labelId="carrier-account-label"
              label={environment === 'production'
                ? 'LIVE production billing account'
                : 'Sandbox billing account'}
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
              disabled={busy || diagnosticCarrierAccounts.length === 1}
            >
              {diagnosticCarrierAccounts.map((entry) => (
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
            disabled={busy || ratingOnlyDelegation || !form.clientId.trim() || !form.clientSecret.trim()}
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
          {canRevealCredentials && account?.credentialRevealAllowed !== false ? (
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
            disabled={busy || ratingOnlyDelegation || !account?.configured}
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
                  sx={iconActionSx}
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
                          sx={iconActionSx}
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
                          sx={iconActionSx}
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
                      disabled={busy || ratingOnlyDelegation || entry.status === 'needs_configuration'}
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
                        disabled={busy || ratingOnlyDelegation}
                        sx={{ minHeight: 44, minWidth: 44 }}
                      >
                        Edit
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
                disabled={busy || ratingOnlyDelegation}
                inputProps={{ maxLength: 120 }}
                sx={fieldSx}
              />
              {editingCarrierAccountGlobalId ? (
                <TextField
                  label="Account number"
                  value={`••••${account?.carrierAccounts.find((entry) => (
                    entry.globalId === editingCarrierAccountGlobalId
                  ))?.accountNumberLastFour || ''}`}
                  helperText="Account numbers cannot be changed after creation. Add a new account if the billing identity changes."
                  InputProps={{ readOnly: true }}
                  disabled={busy || ratingOnlyDelegation}
                  sx={fieldSx}
                />
              ) : (
                <TextField
                  required
                  label="Account number"
                  value={carrierAccountForm.accountNumber}
                  onChange={(event) => updateCarrierAccountForm('accountNumber', event.target.value)}
                  disabled={busy || ratingOnlyDelegation}
                  autoComplete="off"
                  sx={fieldSx}
                />
              )}
              <TextField
                required
                label="Sender name"
                value={carrierAccountForm.senderName}
                onChange={(event) => updateCarrierAccountForm('senderName', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                inputProps={{ maxLength: 120 }}
                helperText="Used as the shipper name for carrier rating and labels."
                sx={{ ...fieldSx, gridColumn: { sm: '1 / -1' } }}
              />
              <TextField
                required
                label="Registered address line 1"
                value={carrierAccountForm.line1}
                onChange={(event) => updateCarrierAccountForm('line1', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                sx={fieldSx}
              />
              <TextField
                label="Registered address line 2"
                value={carrierAccountForm.line2}
                onChange={(event) => updateCarrierAccountForm('line2', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                sx={fieldSx}
              />
              <TextField
                required
                label="City"
                value={carrierAccountForm.city}
                onChange={(event) => updateCarrierAccountForm('city', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                sx={fieldSx}
              />
              <TextField
                required
                label="State / region"
                value={carrierAccountForm.region}
                onChange={(event) => updateCarrierAccountForm('region', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                sx={fieldSx}
              />
              <TextField
                required
                label="Postal code"
                value={carrierAccountForm.postalCode}
                onChange={(event) => updateCarrierAccountForm('postalCode', event.target.value)}
                disabled={busy || ratingOnlyDelegation}
                sx={fieldSx}
              />
              <TextField
                required
                label="Country code"
                value={carrierAccountForm.countryCode}
                onChange={(event) => updateCarrierAccountForm('countryCode', event.target.value.toUpperCase())}
                disabled={busy || ratingOnlyDelegation}
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
                    disabled={busy || ratingOnlyDelegation}
                  />
                )}
                label="Sender"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowRecipientBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowRecipientBilling', value)}
                    disabled={busy || ratingOnlyDelegation}
                  />
                )}
                label="Recipient"
              />
              <FormControlLabel
                control={(
                  <Switch
                    checked={carrierAccountForm.allowThirdPartyBilling}
                    onChange={(_, value) => updateCarrierAccountForm('allowThirdPartyBilling', value)}
                    disabled={busy || ratingOnlyDelegation}
                  />
                )}
                label="Third party"
              />
            </Stack>
            <Button
              type="submit"
              variant="outlined"
              startIcon={<AddRounded />}
              disabled={busy || ratingOnlyDelegation}
              sx={buttonSx}
            >
              {editingCarrierAccountGlobalId ? 'Save account' : 'Add account'}
            </Button>
          </Box>
            </Box>
          ) : null}
        </>
      ) : (
        <Box sx={{ mb: 2, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: '8px' }}>
          <Typography variant="subtitle2" fontWeight={700}>
            Managed rating identity
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Read-only operational facts used for the quote. Sensitive credentials and the full billing
            account number stay hidden.
          </Typography>
          <Stack spacing={1} sx={{ mt: 1.25 }}>
            {activeCarrierAccounts.map((entry) => (
              <Box key={entry.globalId}>
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="body2" fontWeight={650}>{entry.displayName}</Typography>
                  <Chip size="small" variant="outlined" label={`ending ${entry.accountNumberLastFour}`} />
                  <Chip size="small" variant="outlined" label={entry.globalId} />
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block">
                  Sender: {entry.senderName}
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  {entry.registeredAddress.line1}, {entry.registeredAddress.city},{' '}
                  {entry.registeredAddress.region} {entry.registeredAddress.postalCode}
                </Typography>
              </Box>
            ))}
          </Stack>
        </Box>
      )}

      {provider !== 'usps_rest' ? (
        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" fontWeight={700}>
            {environment === 'production'
              ? 'LIVE production shipping account diagnostic'
              : sourceManagedDelegation
              ? ratingOnlyDelegation
                ? 'Sandbox rate test'
                : managedSandboxFulfillmentDelegation
                  ? 'Managed sandbox label test workflow'
                  : 'Managed sandbox diagnostics'
              : 'Sandbox label test workflow'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {environment === 'production'
              ? 'Choose one exact production account, rate an editable parcel, buy the exact selected rate as REAL POSTAGE, print the stored provider bytes, then void it immediately.'
              : sourceManagedDelegation
              ? ratingOnlyDelegation
                ? 'Rate an editable US destination from the AG Alchemy warehouse. No carrier mutation follows the quote.'
                : managedSandboxFulfillmentDelegation
                  ? 'Rate an editable US destination, choose one exact returned service, create one provider sandbox sample, then download or test-print its stored bytes and void or close it.'
                  : 'This managed lane is disabled until its exact AG Alchemy delegation policy is restored.'
              : 'Rate an editable US destination, choose one exact returned service, create a sandbox label, print its stored bytes, and void it when the test is complete.'}
          </Typography>
          {labelWorkflowAuthorized ? (
            <Stepper
              activeStep={labelWorkflowStep}
              alternativeLabel
              sx={{ mt: 2, mb: 2, '& .MuiStepLabel-label': { fontSize: '0.75rem' } }}
            >
              {['Rate', environment === 'production' ? 'Buy LIVE label' : 'Create label', 'Print stored label', environment === 'production' ? 'Void' : 'Void / close'].map((label) => (
                <Step key={label}><StepLabel>{label}</StepLabel></Step>
              ))}
            </Stepper>
          ) : null}
          {labelWorkflowAuthorized && !canExecute ? (
            <Alert severity="info" sx={{ mb: 2, borderRadius: '8px' }}>
              You can run rating diagnostics, but creating, printing, or voiding a label requires
              warehouse-execution permission.
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
                Select an active {environment === 'production' ? 'LIVE production' : 'sandbox'} billing account.
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
              helperText="Shipping account diagnostics are currently US-only"
              sx={fieldSx}
            />
          </Box>
          <FormControlLabel
            control={(
              <Checkbox
                checked={destinationResidential}
                onChange={(_, checked) => updateDestinationResidential(checked)}
                disabled={busy}
              />
            )}
            label="Residential destination"
            sx={{ mt: 0.5, ml: 0 }}
          />
          <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 1.5, mb: 1 }}>
            Test parcel
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: '2fr repeat(4, 1fr)' }, gap: 1.5 }}>
            <TextField
              required
              label="Description"
              value={providerRateParcel.description}
              onChange={(event) => updateRateParcel('description', event.target.value)}
              disabled={busy}
              inputProps={{ maxLength: 120 }}
              sx={fieldSx}
            />
            {(['length', 'width', 'height', 'weight'] as const).map((field) => (
              <TextField
                key={field}
                required
                type="number"
                label={field === 'weight' ? 'Weight (lb)' : `${field[0].toUpperCase()}${field.slice(1)} (in)`}
                value={providerRateParcel[field]}
                onChange={(event) => updateRateParcel(field, Number(event.target.value))}
                disabled={busy}
                inputProps={{ min: 0.01, max: field === 'weight' ? 150 : 108, step: 0.01 }}
                sx={fieldSx}
              />
            ))}
          </Box>
          <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 0.75 }}>
            Sent unchanged: {providerRateParcel.length} × {providerRateParcel.width} ×{' '}
            {providerRateParcel.height} {providerRateParcel.dimensionUnit} · {providerRateParcel.weight}{' '}
            {providerRateParcel.weightUnit} ({selectedUnitRateParcelDimensions} · {selectedUnitRateParcelWeight}).
          </Typography>
          <Typography variant="caption" color="text.disabled" display="block">
            Rating returns prices only. No label media, shipment, pickup, manifest, tracking record, print
            job, or carrier charge is created. Enter test data; durable evidence retains address fingerprints,
            not the entered name or street.
          </Typography>
          <Box sx={{ mt: 1.5 }}>
            <Tooltip title={
              (environment === 'production' ? productionRateBlocker : sandboxRateBlocker)
              || (!rateDestinationComplete
                ? 'Complete the US test destination first.'
                : !diagnosticParcelComplete
                  ? 'Complete the test parcel first.'
                  : `Returns ${environment === 'production' ? 'LIVE production' : 'sandbox'} prices from the exact selected account.`)
            }>
              <span>
                <Button
                  variant="outlined"
                  startIcon={pendingAction === 'rate'
                    ? <CircularProgress size={16} color="inherit" />
                    : <PriceCheckRounded />}
                  disabled={
                    busy
                    || Boolean(environment === 'production' ? productionRateBlocker : sandboxRateBlocker)
                    || !rateDestinationComplete
                    || !diagnosticParcelComplete
                  }
                  onClick={() => {
                    void patch(
                      'rate',
                      {
                        action: 'test-shipping-diagnostic-rate',
                        provider,
                        environment,
                        integrationAccountGlobalId: account?.globalId,
                        carrierAccountGlobalId: selectedCarrierAccountGlobalId,
                        destination: rateDestination,
                        destinationResidential,
                        parcel: providerRateParcel,
                      },
                      `${providerLabel(provider)} ${environment === 'production' ? 'LIVE production' : 'sandbox'} rates returned from the exact selected account.`,
                    ).then((result) => {
                      if (!result?.rateTest) return
                      setRateTest(result.rateTest)
                      setSelectedRateKey('')
                      setSelectedRateTestLabelGlobalId('')
                      setRateTestPrintJob(null)
                      setCreateLabelReason('')
                      setCreateLabelConfirmed(false)
                      setProductionPostageTypedConfirmation('')
                      setCreateLabelIdempotencyKey('')
                      setRateDestinations((current) => ({
                        ...current,
                        [key]: result.rateTest!.fixture.destination,
                      }))
                      setRateParcels((current) => ({
                        ...current,
                        [key]: result.rateTest!.fixture.parcel,
                      }))
                      setRateDestinationResidential((current) => ({
                        ...current,
                        [key]: result.rateTest!.fixture.destination.residential === true,
                      }))
                    })
                  }}
                  sx={buttonSx}
                >
                  Get {environment === 'production' ? 'LIVE production' : 'sandbox'} rates
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
                      setProductionPostageTypedConfirmation('')
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
                {rateTest.environment === 'production' ? 'LIVE production account' : 'Sandbox account'}:{' '}
                {rateTest.carrierAccountGlobalId} · {rateTest.billingRelationship.replace('_', ' ')} · Evidence{' '}
                {rateTest.evidenceGlobalId} · {formatUserDateTime(rateTest.testedAt, dateTimeSettings, {
                  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </Typography>
            </Stack>
          ) : null}

          {labelWorkflowAuthorized ? (
            <>
          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="overline" color="text.disabled">
              Step 2 · {environment === 'production' ? 'Buy LIVE label' : 'Create label'}
            </Typography>
            <Typography variant="subtitle2" fontWeight={700}>Confirm one exact returned rate</Typography>
            {!rateTest ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Run an exact {environment === 'production' ? 'LIVE production' : 'sandbox'} rate first.
                Label creation is never available from a manually entered service or price.
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
                <FormControl fullWidth size="small" sx={fieldSx}>
                  <InputLabel id="rate-test-label-output-format">
                    Carrier label output
                  </InputLabel>
                  <Select
                    labelId="rate-test-label-output-format"
                    label="Carrier label output"
                    value={selectedLabelOutput?.format || ''}
                    onChange={(event) => {
                      setSelectedLabelOutputFormats((current) => ({
                        ...current,
                        [labelOutputProvider]: event.target.value as 'ZPL' | 'PDF' | 'PNG',
                      }))
                      setCreateLabelConfirmed(false)
                      setProductionPostageTypedConfirmation('')
                      setCreateLabelIdempotencyKey('')
                    }}
                    disabled={busy || availableLabelOutputs.length < 2}
                  >
                    {availableLabelOutputs.map((output) => (
                      <MenuItem key={output.format} value={output.format}>
                        {output.format} · 4 × 6 · carrier native
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {selectedLabelOutput ? (
                  <Alert
                    severity={selectedOutputCompatiblePrinters.length ? 'success' : 'info'}
                    sx={{ borderRadius: '8px' }}
                  >
                    {selectedLabelOutput.format === 'ZPL'
                      ? `${providerLabel(provider)} will return its native Zebra command stream.`
                      : `${providerLabel(provider)} will return its native ${selectedLabelOutput.format} file; ClawPilot does not rasterize or replace the provider source.`}
                    {' '}
                    {selectedOutputCompatiblePrinters.length
                      ? `${selectedOutputCompatiblePrinters.length} online print route${selectedOutputCompatiblePrinters.length === 1 ? '' : 's'} currently match this output.`
                      : 'No online print route currently matches this output; the provider file will still remain stored for an explicitly compatible route.'}
                  </Alert>
                ) : null}
                <TextField
                  required
                  multiline
                  minRows={2}
                  label={environment === 'production' ? 'LIVE postage test reason' : 'Test-label reason'}
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
                {environment === 'production' ? (
                  <>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                      <TextField
                        required
                        label="Sender phone"
                        value={diagnosticSenderPhone}
                        onChange={(event) => {
                          setDiagnosticSenderPhones((current) => ({ ...current, [key]: event.target.value }))
                          setCreateLabelIdempotencyKey('')
                        }}
                        disabled={busy}
                        inputProps={{ maxLength: 24 }}
                        sx={fieldSx}
                      />
                      <TextField
                        required
                        label="Recipient phone"
                        value={diagnosticRecipientPhone}
                        onChange={(event) => {
                          setDiagnosticRecipientPhones((current) => ({ ...current, [key]: event.target.value }))
                          setCreateLabelIdempotencyKey('')
                        }}
                        disabled={busy}
                        inputProps={{ maxLength: 24 }}
                        sx={fieldSx}
                      />
                    </Box>
                    <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                      REAL POSTAGE: buying this exact {providerLabel(provider)} rate can incur a production
                      charge. Print the stored provider bytes, then use the true carrier void below immediately.
                    </Alert>
                    <TextField
                      required
                      label="Type the exact REAL POSTAGE confirmation"
                      value={productionPostageTypedConfirmation}
                      onChange={(event) => {
                        setProductionPostageTypedConfirmation(event.target.value)
                        setCreateLabelIdempotencyKey('')
                      }}
                      disabled={busy}
                      helperText={selectedProductionConfirmation}
                      inputProps={{ maxLength: 300 }}
                      sx={fieldSx}
                    />
                    {productionCreateBlocker ? (
                      <Typography variant="caption" color="warning.main">
                        {productionCreateBlocker}
                      </Typography>
                    ) : null}
                  </>
                ) : (
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
                )}
                <Box>
                  <Button
                    variant="contained"
                    startIcon={pendingAction === 'create-rate-test-label'
                      ? <CircularProgress size={16} color="inherit" />
                      : <LocalShippingRounded />}
                    disabled={
                      busy
                      || !canExecute
                      || !selectedLabelOutput
                      || (environment === 'sandbox' && !createLabelConfirmed)
                      || (environment === 'production' && Boolean(productionCreateBlocker))
                      || (
                        environment === 'production'
                        && productionPostageTypedConfirmation !== selectedProductionConfirmation
                      )
                      || !createLabelReason.trim()
                    }
                    onClick={() => void createRateTestLabel()}
                    sx={buttonSx}
                  >
                    {environment === 'production'
                      ? 'Buy and store LIVE production label'
                      : 'Create and store sandbox label'}
                  </Button>
                </Box>
              </Stack>
            )}
          </Box>

          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="overline" color="text.disabled">
              Stored {environment === 'production' ? 'LIVE production' : 'sandbox test'} labels
            </Typography>
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
                            label={label.status === 'created'
                              ? 'Created'
                              : (
                                rateTestAttempts.find((attempt) => (
                                  attempt.labelGlobalId === label.globalId
                                  && attempt.action === 'void'
                                  && attempt.reconciliationOutcome === 'confirmed_no_active_label'
                                ))
                                  ? 'Closed sample'
                                  : 'Voided'
                              )}
                          />
                          <Chip size="small" variant="outlined" label={label.globalId} />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block">
                          Tracking {label.trackingNumber} · {label.ratedCurrency} {label.ratedAmount} ·{' '}
                          {label.format} {label.mediaSize.replace('label_', '').replace('x', ' × ')}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          {label.environment === 'production' ? 'LIVE production' : 'Sandbox'} account{' '}
                          {label.carrierAccountGlobalId}
                        </Typography>
                        <Typography variant="caption" color="text.disabled" display="block">
                          Provider-native {label.providerImageType} · source bytes immutable
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
                No {providerLabel(provider)} {environment === 'production' ? 'LIVE production' : 'sandbox test'} labels have been stored for this organization.
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

          <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="overline" color="text.disabled">Step 3 · Print stored label</Typography>
            <Typography variant="subtitle2" fontWeight={700}>
              {selectedRateTestLabel
                ? `Route ${selectedRateTestLabel.globalId} to a compatible printer`
                : 'Print readiness'}
            </Typography>
            {selectedRateTestLabel ? (
              <>
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
                    Provider-native {selectedRateTestLabel.providerImageType} · Stored bytes:{' '}
                    {selectedRateTestLabel.byteLength.toLocaleString()} · SHA-256{' '}
                    {selectedRateTestLabel.contentSha256.slice(0, 16)}…
                  </Typography>
                </Box>
                {canExecute && (selectedRateTestLabel.printArtifactGlobalId
                  || (
                    rateTestPrintJob?.sourceLabelGlobalId === selectedRateTestLabel.globalId
                      ? rateTestPrintJob.artifactGlobalId
                      : null
                  )) ? (
                  <Box sx={{ mt: 1.5 }}>
                    <Button
                      component="a"
                      href={`/api/operations/artifacts/${encodeURIComponent(
                        selectedRateTestLabel.printArtifactGlobalId
                        || rateTestPrintJob?.artifactGlobalId
                        || '',
                      )}`}
                      download
                      variant="outlined"
                      startIcon={<DownloadRounded />}
                      sx={buttonSx}
                    >
                      Download stored {selectedRateTestLabel.format}
                    </Button>
                  </Box>
                ) : null}
              </>
            ) : null}
            {printReadinessBlocker === 'label_required' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="info"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                Create or select a stored {environment === 'production' ? 'LIVE production' : 'sandbox'} label before printing.
              </Alert>
            ) : printReadinessBlocker === 'execution_permission_required' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                Warehouse-execution permission is required to test print stored labels.
              </Alert>
            ) : printReadinessBlocker === 'label_voided' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                This label is voided and cannot be queued for a new test print.
              </Alert>
            ) : printReadinessBlocker === 'printer_profile_required' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                No available printer profiles are configured in an active warehouse for this organization.
                Configure a shipping-label printer profile before printing.
              </Alert>
            ) : printReadinessBlocker === 'exact_printer_capability_required' && selectedRateTestLabel ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                Printer profiles are configured, but none supports shipping labels in{' '}
                {selectedRateTestLabel.format} on {selectedRateTestLabel.mediaSize}.{' '}
                {selectedRateTestLabel.format === 'PDF'
                  ? `This provider PDF remains immutable. Void it below, run a new ${environment === 'production' ? 'LIVE production' : 'sandbox'} rate, and create a new provider-native thermal ZPL label for a ZPL printer; or configure a PDF-capable local print service.`
                  : 'Configure a printer that explicitly supports this exact format and media before printing.'}
              </Alert>
            ) : printReadinessBlocker === 'compatible_printer_offline' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                An exact-compatible printer profile exists, but none is online. Bring one online or re-enable
                a disabled compatible profile before printing.
              </Alert>
            ) : printReadinessBlocker === 'active_local_agent_required' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="warning"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                An online exact-compatible printer exists, but none is bound to an active enrolled local print
                agent. Bind or reactivate its agent, or switch the printer to local-agent delivery, before
                printing.
              </Alert>
            ) : printReadinessBlocker === 'printer_selection_required' ? (
              <Alert
                id="rate-test-print-readiness-message"
                severity="info"
                sx={{ mt: 1.5, borderRadius: '8px' }}
              >
                Select one compatible printer to enable the test print.
              </Alert>
            ) : null}
            {selectedRateTestLabel
              && canExecute
              && selectedRateTestLabel.status !== 'voided'
              && compatibleRateTestPrinters.length ? (
              <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
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
            ) : null}
            <Box sx={{ mt: 1.5 }}>
              <Button
                variant="contained"
                startIcon={pendingAction === 'print-rate-test-label'
                  ? <CircularProgress size={16} color="inherit" />
                  : <PrintRounded />}
                disabled={busy || !testPrintEligible}
                aria-describedby={printReadinessBlocker ? 'rate-test-print-readiness-message' : undefined}
                onClick={() => void printRateTestLabel()}
                sx={buttonSx}
              >
                Print stored {environment === 'production' ? 'LIVE label' : 'test label'}
              </Button>
            </Box>
            {selectedRateTestLabel
              && rateTestPrintJob?.sourceLabelGlobalId === selectedRateTestLabel.globalId ? (
                <Alert
                  severity={rateTestPrintJob.status === 'failed' ? 'warning' : 'success'}
                  sx={{ mt: 1.5, borderRadius: '8px' }}
                >
                  Print job {rateTestPrintJob.globalId} is {rateTestPrintJob.status} for{' '}
                  {rateTestPrintJob.printerName}. Retry and controlled reprint remain available in
                  Operations print jobs and reuse the same stored label bytes.
                </Alert>
              ) : null}
          </Box>

          {selectedRateTestLabel ? (
            <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="overline" color="text.disabled">
                  Step 4 · {selectedRateTestLabel.lifecycleMode === 'close_sample'
                    ? 'Close sample'
                    : 'Void'}
                </Typography>
                <Typography variant="subtitle2" fontWeight={700}>
                  {selectedRateTestLabel.lifecycleMode === 'close_sample'
                    ? 'Close the UPS CIE sample evidence'
                    : selectedRateTestLabel.environment === 'production'
                      ? 'Void the LIVE production label'
                      : 'Void the carrier-side test'}
                </Typography>
                {selectedRateTestLabel.status === 'voided' ? (
                  <Alert severity="success" sx={{ mt: 1.5, borderRadius: '8px' }}>
                    {selectedRateTestLabelClosedWithoutCarrierVoid
                      ? 'Closed locally after confirming that this UPS CIE sample never represented an active carrier shipment. No carrier void was recorded.'
                      : `Voided ${selectedRateTestLabel.voidedAt
                        ? formatUserDateTime(selectedRateTestLabel.voidedAt, dateTimeSettings, {
                            year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                          })
                        : 'successfully'}.`}
                  </Alert>
                ) : (
                  <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                    {selectedRateTestLabel.lifecycleMode === 'close_sample' ? (
                      <Alert severity="info" sx={{ borderRadius: '8px' }}>
                        UPS CIE returned the printable sample reference{' '}
                        {selectedRateTestLabel.trackingNumber}, not an active carrier shipment. Closing this
                        sample retires it in ClawPilot with audited no-active-label evidence and makes no UPS
                        API call.
                      </Alert>
                    ) : (
                      <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                        {selectedRateTestLabel.environment === 'production' ? 'TRUE PROVIDER VOID' : 'Voiding'}{' '}
                        calls the carrier for tracking {selectedRateTestLabel.trackingNumber}. It does not
                        delete the stored label or audit record.
                      </Alert>
                    )}
                    {selectedRateTestLabelVoidAttempt?.state === 'failed' ? (
                      <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                        Previous void attempt {selectedRateTestLabelVoidAttempt.globalId} failed with{' '}
                        {selectedRateTestLabelVoidAttempt.errorCode || 'a carrier rejection'}
                        {selectedRateTestLabelVoidAttempt.providerErrorCodes.length
                          ? ` · provider code ${selectedRateTestLabelVoidAttempt.providerErrorCodes.join(', ')}`
                          : ''}
                        . The local label remains active until this step completes.
                      </Alert>
                    ) : null}
                    {selectedRateTestLabel.lifecycleMode === 'close_sample' && !canReconcile ? (
                      <Alert severity="warning" sx={{ borderRadius: '8px' }}>
                        Organization owner or administrator access plus warehouse execution is required to
                        close UPS sample evidence.
                      </Alert>
                    ) : null}
                    <TextField
                      required
                      multiline
                      minRows={2}
                      label={selectedRateTestLabel.lifecycleMode === 'close_sample'
                        ? 'Sample close reason'
                        : 'Void reason'}
                      value={voidLabelReason}
                      onChange={(event) => {
                        setVoidLabelReason(event.target.value)
                        setVoidLabelIdempotencyKey('')
                      }}
                      disabled={busy}
                      inputProps={{ maxLength: 500 }}
                      helperText={`${voidLabelReason.length}/500 · ${
                        selectedRateTestLabel.lifecycleMode === 'close_sample'
                          ? 'recorded with the audited local close'
                          : 'recorded with the carrier void'
                      }`}
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
                      label={selectedRateTestLabel.lifecycleMode === 'close_sample'
                        ? `I confirm ${selectedRateTestLabel.globalId} is the UPS CIE sample ${selectedRateTestLabel.trackingNumber} and should be closed without a carrier call.`
                        : `I confirm I want to void exactly ${selectedRateTestLabel.globalId}, tracking ${selectedRateTestLabel.trackingNumber}.`}
                      sx={{ alignItems: 'flex-start', m: 0 }}
                    />
                    <Box>
                      <Button
                        color="error"
                        variant="outlined"
                        startIcon={(
                          pendingAction === 'void-rate-test-label'
                          || pendingAction === 'close-rate-test-sample-label'
                        )
                          ? <CircularProgress size={16} color="inherit" />
                          : <DeleteOutlineRounded />}
                        disabled={
                          busy
                          || !canExecute
                          || (
                            selectedRateTestLabel.lifecycleMode === 'close_sample'
                            && !canReconcile
                          )
                          || !voidLabelConfirmed
                          || !voidLabelReason.trim()
                        }
                        onClick={() => void voidRateTestLabel()}
                        sx={buttonSx}
                      >
                        {selectedRateTestLabel.lifecycleMode === 'close_sample'
                          ? 'Close UPS sample without carrier call'
                          : selectedRateTestLabel.environment === 'production'
                            ? 'Void exact LIVE production label now'
                            : 'Void exact sandbox label'}
                      </Button>
                    </Box>
                  </Stack>
                )}
            </Box>
          ) : null}
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
              <Button color="inherit" size="small" sx={{ minHeight: 44 }} onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
              <Button
                color="error"
                size="small"
                startIcon={<PowerSettingsNewRounded />}
                sx={{ minHeight: 44 }}
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

      <BrokeredTransportIntegrationPanel focus={brokeredFocus} />
    </Box>
  )
}
