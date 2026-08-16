'use client'

import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import {
  AddPhotoAlternateRounded,
  ImageRounded,
  RefreshRounded,
  StarRounded,
} from '@mui/icons-material'
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ProductSalesChannelState } from '@/lib/crm/types'

type ProductImageAsset = {
  id: string
  productId: string
  assetRevision: number
  rowVersion: number
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  contentSha256: string
  byteLength: number
  pixelWidth: number
  pixelHeight: number
  altText: string
  source: 'manual_upload' | 'provider_import' | 'suitecrm_import' | 'migration'
  isPrimary: boolean
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

type ProductImageState = {
  imageImportAvailable: boolean
  storeSync: Array<{
    accountGlobalId: string
    effectiveState: 'running' | 'paused'
    effectiveReason:
      | 'OPERATIONS_DISABLED_OVERRIDE'
      | 'OPERATIONS_FROZEN_OVERRIDE'
      | 'STORE_SYNC_CONTROL_MISSING'
      | 'STORE_SYNC_ACCOUNT_UNAVAILABLE'
      | 'STORE_SYNC_EXPLICIT_RUNNING'
      | 'STORE_SYNC_EXPLICIT_PAUSED_DRAINING'
      | 'STORE_SYNC_EXPLICIT_PAUSED'
      | 'STORE_SYNC_LEGACY_SHADOW_RUNNING'
      | 'STORE_SYNC_LEGACY_ACTIVE_RUNNING'
      | 'STORE_SYNC_LEGACY_READ_ONLY_PAUSED'
    effectiveReasonLabel: string
  }>
  product: {
    id: string
    referenceCode: string
    pipelineId: string
    name: string
  }
  assets: ProductImageAsset[]
}

type ProductImagePayload = Partial<ProductImageState> & {
  ok?: boolean
  error?: string
  code?: string
}

type ShopifyProductImageProjection = {
  productReferenceCode: string
  channelStateGlobalId: string
  imageAssetId: string
  imageAssetRevision: number
  imageContentSha256: string
  mode: 'shadow' | 'active'
  replayed: boolean
  providerMutation: {
    accepted: boolean
    writeCount: number
  }
  mediaPublication: {
    requested: true
    mediaImageGid: string | null
    status: string | null
    errors: Array<{
      code: string
      message: string
      details: string | null
    }>
    ready: boolean
    positioningRequested: false
    primaryPositionConfirmed: false
    nextAction:
      | 'shadow_simulation'
      | 'await_media_ready'
      | 'investigate_media_failure'
      | 'reorder_to_position_zero'
  }
  externalEffect: {
    globalId: string
    state: string
    providerWriteCount: number
    completedAt: string | null
  }
}

type ShopifyProductImageProjectionPayload = {
  ok?: boolean
  publication?: ShopifyProductImageProjection
  reconciliation?: {
    externalEffectGlobalId: string
    effectState: string
    mediaImageGid: string | null
    status: string | null
    errors: Array<{
      code: string
      message: string
      details: string | null
    }>
    ready: boolean
    terminal: boolean
    providerNetworkCalls: number
    providerWriteCount: 0
    observedAt?: string
    nextAction: string
  }
  error?: string
  code?: string
}

type FaireProductImageRefreshPayload = {
  ok?: boolean
  refresh?: {
    productReferenceCode: string
    channelStateGlobalId: string
    externalProductId: string
    externalVariantId: string
    providerSku: string
    logicalReadOperations: 1
    providerRequests: 2
    providerWrites: 0
    observedImages: number
    jobs: Record<string, number>
    nextAction: 'background_import'
  }
  error?: string
  code?: string
}

type FaireProductImageProjection = {
  productReferenceCode: string
  channelStateGlobalId: string
  imageAssetId: string
  imageAssetRevision: number
  imageContentSha256: string
  mode: 'shadow' | 'active'
  replayed: boolean
  providerMutation: {
    accepted: boolean
    writeCount: number
    uploadAccepted: boolean
    attachmentAccepted: boolean
  }
  images: {
    existingPreserved: boolean
    priorCount: number | null
    projectedCount: number | null
    uploadedLocatorSha256: string | null
  }
  externalEffect: {
    globalId: string
    state: string
    providerWriteCount: number
  }
}

type FaireProductImageProjectionPayload = {
  ok?: boolean
  publication?: FaireProductImageProjection
  externalEffectGlobalId?: string
  reconciliation?: {
    externalEffectGlobalId: string
    outcome: 'observed_applied' | 'observed_absent' | 'manual_review'
    confirmedApplied: boolean
    providerImageCount?: number
    exactLocatorMatchCount?: number
    reason?: string
    terminalized?: boolean
    replayed?: boolean
  }
  error?: string
  code?: string
}

type FaireProductImageRecoveryEffect = {
  externalEffectGlobalId: string
  recoveryState: 'unknown' | 'expired_claim'
  providerWriteCount: number
  uploadedLocatorAvailable: boolean
  reconciliationEligibility: 'readback_terminalizable' | 'manual_review'
  reconciliationReason:
    | 'exact_attach_unknown_evidence'
    | 'exact_attach_succeeded_evidence'
    | 'exact_unknown_effect_evidence'
    | 'upload_locator_unavailable'
    | 'provider_write_count_unsupported'
    | 'exact_attachment_evidence_unavailable'
  productReferenceCode: string
  channelStateGlobalId: string
  assetRevision: number
  assetAltText: string
  latestOutcome: string | null
  latestObservedAt: string | null
  errorCode: string | null
  occurredAt: string
}

type FaireProductImageRecoveryPayload = {
  ok?: boolean
  recoveryEffects?: FaireProductImageRecoveryEffect[]
  providerReads?: number
  providerWrites?: number
  error?: string
  code?: string
}

const PRODUCT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_ALT_TEXT_LENGTH = 500
const EFFECT_GLOBAL_ID = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const PRODUCT_REFERENCE = /^gp(?:[0-9]{7}|[0-9a-v]{12})$/
const CHANNEL_GLOBAL_ID = /^gpcs(?:[0-9]{7}|[0-9a-v]{12})$/
const MANUAL_FAIRE_READ_ALLOWED_REASONS = new Set<ProductImageState[
  'storeSync'
][number]['effectiveReason']>([
  'STORE_SYNC_EXPLICIT_RUNNING',
  'STORE_SYNC_EXPLICIT_PAUSED_DRAINING',
  'STORE_SYNC_EXPLICIT_PAUSED',
  'STORE_SYNC_LEGACY_SHADOW_RUNNING',
  'STORE_SYNC_LEGACY_ACTIVE_RUNNING',
  'STORE_SYNC_LEGACY_READ_ONLY_PAUSED',
])
const RECOVERY_OUTCOMES = new Set([
  'succeeded',
  'failed',
  'unknown',
  'observed_applied',
  'observed_absent',
  'manual_review',
])
const RECOVERY_REASONS = new Set<FaireProductImageRecoveryEffect[
  'reconciliationReason'
]>([
  'exact_attach_unknown_evidence',
  'exact_attach_succeeded_evidence',
  'exact_unknown_effect_evidence',
  'upload_locator_unavailable',
  'provider_write_count_unsupported',
  'exact_attachment_evidence_unavailable',
])

function apiPath(productId: string) {
  return `/api/crm/products/${encodeURIComponent(productId)}/images`
}

function faireProductImagePath(productId: string) {
  return `/api/crm/products/${encodeURIComponent(productId)}/faire-product-image`
}

function assetState(payload: ProductImagePayload): ProductImageState | null {
  if (
    typeof payload.imageImportAvailable !== 'boolean'
    || !payload.product
    || !Array.isArray(payload.assets)
    || !Array.isArray(payload.storeSync)
  ) return null
  return {
    imageImportAvailable: payload.imageImportAvailable,
    storeSync: payload.storeSync,
    product: payload.product,
    assets: payload.assets,
  }
}

function recoveryEffects(
  payload: FaireProductImageRecoveryPayload,
): FaireProductImageRecoveryEffect[] | null {
  if (
    payload.ok !== true
    || payload.providerReads !== 0
    || payload.providerWrites !== 0
    || !Array.isArray(payload.recoveryEffects)
  ) return null
  for (const effect of payload.recoveryEffects) {
    if (
      !effect
      || !EFFECT_GLOBAL_ID.test(effect.externalEffectGlobalId)
      || !['unknown', 'expired_claim'].includes(effect.recoveryState)
      || !Number.isInteger(effect.providerWriteCount)
      || effect.providerWriteCount < 0
      || effect.providerWriteCount > 2
      || typeof effect.uploadedLocatorAvailable !== 'boolean'
      || !['readback_terminalizable', 'manual_review'].includes(
        effect.reconciliationEligibility,
      )
      || !RECOVERY_REASONS.has(effect.reconciliationReason)
      || (
        effect.reconciliationEligibility === 'readback_terminalizable'
        && ![
          'exact_attach_unknown_evidence',
          'exact_attach_succeeded_evidence',
          'exact_unknown_effect_evidence',
        ].includes(effect.reconciliationReason)
      )
      || (
        effect.reconciliationEligibility === 'manual_review'
        && [
          'exact_attach_unknown_evidence',
          'exact_attach_succeeded_evidence',
          'exact_unknown_effect_evidence',
        ].includes(effect.reconciliationReason)
      )
      || !PRODUCT_REFERENCE.test(effect.productReferenceCode)
      || !CHANNEL_GLOBAL_ID.test(effect.channelStateGlobalId)
      || !Number.isInteger(effect.assetRevision)
      || effect.assetRevision < 1
      || typeof effect.assetAltText !== 'string'
      || effect.assetAltText.length < 1
      || effect.assetAltText.length > MAX_ALT_TEXT_LENGTH
      || /[\u0000-\u001f\u007f]/.test(effect.assetAltText)
      || (
        effect.latestOutcome !== null
        && !RECOVERY_OUTCOMES.has(effect.latestOutcome)
      )
      || (
        effect.errorCode !== null
        && !/^[A-Z][A-Z0-9_]{1,127}$/.test(effect.errorCode)
      )
      || Number.isNaN(Date.parse(effect.occurredAt))
      || (
        effect.latestObservedAt !== null
        && Number.isNaN(Date.parse(effect.latestObservedAt))
      )
    ) return null
  }
  return payload.recoveryEffects
}

function displayMimeType(mimeType: ProductImageAsset['mimeType']) {
  if (mimeType === 'image/jpeg') return 'JPEG'
  if (mimeType === 'image/webp') return 'WebP'
  return 'PNG'
}

function faireRecoveryReason(
  reason: FaireProductImageRecoveryEffect['reconciliationReason'],
) {
  switch (reason) {
    case 'exact_attach_unknown_evidence':
      return 'exact uncertain attachment evidence is preserved'
    case 'exact_attach_succeeded_evidence':
      return 'exact completed attachment evidence is preserved'
    case 'exact_unknown_effect_evidence':
      return 'exact uncertain effect evidence is preserved'
    case 'upload_locator_unavailable':
      return 'the durable upload fingerprint is unavailable'
    case 'provider_write_count_unsupported':
      return 'the durable provider-write count is unsupported'
    default:
      return 'exact attachment identity and image-count evidence is incomplete'
  }
}

function displayBytes(byteLength: number) {
  if (byteLength >= 1024 * 1024) {
    return `${(byteLength / (1024 * 1024)).toFixed(2)} MB`
  }
  return `${Math.max(1, Math.round(byteLength / 1024))} KB`
}

function displaySource(source: ProductImageAsset['source']) {
  if (source === 'provider_import') return 'Provider import'
  if (source === 'suitecrm_import') return 'SuiteCRM import'
  if (source === 'migration') return 'Migration'
  return 'Manual upload'
}

function hashPrefix(hash: string) {
  return `${hash.slice(0, 12)}…`
}

export default function ProductImagePanel({
  productId,
  canManage,
  shopifyChannels,
  faireChannels,
}: {
  productId: string
  canManage: boolean
  shopifyChannels: ProductSalesChannelState[]
  faireChannels: ProductSalesChannelState[]
}) {
  const fileInput = useRef<HTMLInputElement | null>(null)
  const faireRecoveryLoadGeneration = useRef(0)
  const pendingFaireRefresh = useRef<{
    fingerprint: string
    idempotencyKey: string
  } | null>(null)
  const [state, setState] = useState<ProductImageState | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [altText, setAltText] = useState('')
  const [setPrimary, setSetPrimary] = useState(true)
  const [selectedShopifyChannel, setSelectedShopifyChannel] = useState('')
  const [selectedShopifyAsset, setSelectedShopifyAsset] = useState('')
  const [selectedFaireChannel, setSelectedFaireChannel] = useState('')
  const [selectedFaireAsset, setSelectedFaireAsset] = useState('')
  const [activePublishConfirmed, setActivePublishConfirmed] = useState(false)
  const [fairePublishConfirmed, setFairePublishConfirmed] = useState(false)
  const [projection, setProjection] =
    useState<ShopifyProductImageProjection | null>(null)
  const [reconciliation, setReconciliation] =
    useState<NonNullable<
      ShopifyProductImageProjectionPayload['reconciliation']
    > | null>(null)
  const [faireProjection, setFaireProjection] =
    useState<FaireProductImageProjection | null>(null)
  const [faireReconciliation, setFaireReconciliation] =
    useState<NonNullable<
      FaireProductImageProjectionPayload['reconciliation']
    > | null>(null)
  const [faireRecoveryEffects, setFaireRecoveryEffects] =
    useState<FaireProductImageRecoveryEffect[]>([])
  const [loading, setLoading] = useState(canManage)
  const [loadingFaireRecoveries, setLoadingFaireRecoveries] =
    useState(canManage)
  const [saving, setSaving] = useState(false)
  const [projecting, setProjecting] = useState(false)
  const [refreshingFaire, setRefreshingFaire] = useState(false)
  const [publishingFaire, setPublishingFaire] = useState(false)
  const [reconcilingFaireEffect, setReconcilingFaireEffect] = useState('')
  const [error, setError] = useState('')
  const [faireRecoveryError, setFaireRecoveryError] = useState('')
  const [notice, setNotice] = useState('')

  const loadFaireRecoveryEffects = useCallback(async () => {
    const loadGeneration = ++faireRecoveryLoadGeneration.current
    if (!canManage || !PRODUCT_ID_PATTERN.test(productId)) {
      setFaireRecoveryEffects([])
      setFaireRecoveryError('')
      setLoadingFaireRecoveries(false)
      return
    }
    setLoadingFaireRecoveries(true)
    setFaireRecoveryError('')
    try {
      const response = await fetch(faireProductImagePath(productId), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      const payload = (
        await response.json().catch(() => ({}))
      ) as FaireProductImageRecoveryPayload
      const nextEffects = recoveryEffects(payload)
      if (!response.ok || nextEffects === null) {
        throw new Error(
          payload.error || 'Faire image recovery records did not load',
        )
      }
      if (faireRecoveryLoadGeneration.current !== loadGeneration) return
      setFaireRecoveryEffects(nextEffects)
    } catch (loadError) {
      if (faireRecoveryLoadGeneration.current !== loadGeneration) return
      setFaireRecoveryError(
        loadError instanceof Error
          ? loadError.message
          : 'Faire image recovery records did not load',
      )
    } finally {
      if (faireRecoveryLoadGeneration.current === loadGeneration) {
        setLoadingFaireRecoveries(false)
      }
    }
  }, [canManage, productId])

  const load = useCallback(async () => {
    if (!canManage || !PRODUCT_ID_PATTERN.test(productId)) {
      setState(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await fetch(apiPath(productId), {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      const payload = (
        await response.json().catch(() => ({}))
      ) as ProductImagePayload
      const nextState = assetState(payload)
      if (!response.ok || payload.ok !== true || !nextState) {
        throw new Error(payload.error || 'Product images did not load')
      }
      setState(nextState)
      setProjection(null)
      setReconciliation(null)
      setActivePublishConfirmed(false)
      setFaireProjection(null)
      setFaireReconciliation(null)
      setFairePublishConfirmed(false)
    } catch (loadError) {
      setState(null)
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Product images did not load',
      )
    } finally {
      setLoading(false)
    }
  }, [canManage, productId])

  useEffect(() => {
    setSelectedFile(null)
    setAltText('')
    setSetPrimary(true)
    setSelectedShopifyChannel('')
    setSelectedShopifyAsset('')
    setSelectedFaireChannel('')
    setSelectedFaireAsset('')
    setActivePublishConfirmed(false)
    setFairePublishConfirmed(false)
    setProjection(null)
    setReconciliation(null)
    setFaireProjection(null)
    setFaireReconciliation(null)
    setFaireRecoveryEffects([])
    setFaireRecoveryError('')
    setReconcilingFaireEffect('')
    setNotice('')
    setError('')
    if (fileInput.current) fileInput.current.value = ''
    void load()
    void loadFaireRecoveryEffects()
  }, [load, loadFaireRecoveryEffects])

  useEffect(() => {
    if (
      selectedShopifyChannel
      && shopifyChannels.some(
        (channel) => channel.globalId === selectedShopifyChannel,
      )
    ) {
      return
    }
    setSelectedShopifyChannel(shopifyChannels[0]?.globalId || '')
  }, [selectedShopifyChannel, shopifyChannels])

  useEffect(() => {
    if (
      selectedFaireChannel
      && faireChannels.some(
        (channel) => channel.globalId === selectedFaireChannel,
      )
    ) {
      return
    }
    setSelectedFaireChannel(faireChannels[0]?.globalId || '')
  }, [selectedFaireChannel, faireChannels])

  useEffect(() => {
    const assets = state?.assets || []
    if (
      selectedShopifyAsset
      && assets.some((asset) => asset.id === selectedShopifyAsset)
    ) {
      return
    }
    setSelectedShopifyAsset(
      assets.find((asset) => asset.isPrimary)?.id || assets[0]?.id || '',
    )
  }, [selectedShopifyAsset, state?.assets])

  useEffect(() => {
    const assets = state?.assets || []
    if (
      selectedFaireAsset
      && assets.some((asset) => asset.id === selectedFaireAsset)
    ) return
    setSelectedFaireAsset(
      assets.find((asset) => asset.isPrimary)?.id || assets[0]?.id || '',
    )
  }, [selectedFaireAsset, state?.assets])

  const selectedChannelEvidence = shopifyChannels.find(
    (channel) => channel.globalId === selectedShopifyChannel,
  ) || null
  const selectedAssetEvidence = state?.assets.find(
    (asset) => asset.id === selectedShopifyAsset,
  ) || null
  const selectedFaireChannelEvidence = faireChannels.find(
    (channel) => channel.globalId === selectedFaireChannel,
  ) || null
  const selectedFaireStoreSync = state?.storeSync.find(
    (control) => control.accountGlobalId
      === selectedFaireChannelEvidence?.integrationAccountGlobalId,
  ) || null
  const selectedFaireStoreSyncRunning =
    selectedFaireStoreSync?.effectiveState === 'running'
  const selectedFaireManualReadAllowed = Boolean(
    selectedFaireStoreSync
    && MANUAL_FAIRE_READ_ALLOWED_REASONS.has(
      selectedFaireStoreSync.effectiveReason,
    ),
  )
  const selectedFaireStoreSyncNormallyPaused = Boolean(
    selectedFaireManualReadAllowed
    && !selectedFaireStoreSyncRunning,
  )
  const selectedFaireAssetEvidence = state?.assets.find(
    (asset) => asset.id === selectedFaireAsset,
  ) || null
  const exactShadowSimulation = projection?.mode === 'shadow'
    && projection.productReferenceCode === state?.product.referenceCode
    && projection.channelStateGlobalId
      === selectedChannelEvidence?.globalId
    && projection.imageAssetId === selectedAssetEvidence?.id
    && projection.imageAssetRevision
      === selectedAssetEvidence?.assetRevision
    && projection.imageContentSha256
      === selectedAssetEvidence?.contentSha256
    && projection.externalEffect.state === 'simulated'
    && projection.externalEffect.providerWriteCount === 0
    ? projection
    : null
  const exactFaireShadowSimulation = faireProjection?.mode === 'shadow'
    && faireProjection.productReferenceCode === state?.product.referenceCode
    && faireProjection.channelStateGlobalId
      === selectedFaireChannelEvidence?.globalId
    && faireProjection.imageAssetId === selectedFaireAssetEvidence?.id
    && faireProjection.imageAssetRevision
      === selectedFaireAssetEvidence?.assetRevision
    && faireProjection.imageContentSha256
      === selectedFaireAssetEvidence?.contentSha256
    && faireProjection.externalEffect.state === 'simulated'
    && faireProjection.externalEffect.providerWriteCount === 0
    ? faireProjection
    : null

  useEffect(() => {
    setProjection(null)
    setReconciliation(null)
    setActivePublishConfirmed(false)
  }, [
    selectedChannelEvidence?.rowVersion,
    selectedChannelEvidence?.sourceRevision,
    selectedAssetEvidence?.assetRevision,
    selectedAssetEvidence?.rowVersion,
    selectedAssetEvidence?.contentSha256,
  ])

  useEffect(() => {
    setFaireProjection(null)
    setFaireReconciliation(null)
    setFairePublishConfirmed(false)
  }, [
    selectedFaireChannelEvidence?.rowVersion,
    selectedFaireChannelEvidence?.sourceRevision,
    selectedFaireAssetEvidence?.assetRevision,
    selectedFaireAssetEvidence?.rowVersion,
    selectedFaireAssetEvidence?.contentSha256,
  ])

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    setError('')
    setNotice('')
    const file = event.target.files?.[0] || null
    if (!file) {
      setSelectedFile(null)
      return
    }
    if (!SUPPORTED_MIME_TYPES.includes(
      file.type as (typeof SUPPORTED_MIME_TYPES)[number],
    )) {
      setSelectedFile(null)
      event.target.value = ''
      setError('Choose a PNG, JPEG, or WebP image.')
      return
    }
    if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      setSelectedFile(null)
      event.target.value = ''
      setError('Product images must be no larger than 2 MB.')
      return
    }
    setSelectedFile(file)
  }

  const refreshShopifyMediaStatus = async () => {
    if (!projection || projection.mode !== 'active') return
    setProjecting(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(
        `/api/crm/products/${encodeURIComponent(productId)}/shopify-product-image`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'refresh-product-image-status',
            externalEffectGlobalId:
              projection.externalEffect.globalId,
          }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as ShopifyProductImageProjectionPayload
      if (!response.ok || payload.ok !== true || !payload.reconciliation) {
        throw new Error(
          payload.error || 'Shopify media status did not refresh',
        )
      }
      setReconciliation(payload.reconciliation)
      setNotice(
        payload.reconciliation.ready
          ? 'Shopify reports the image READY. Featured position remains a separate reorder.'
          : payload.reconciliation.status === 'FAILED'
            ? 'Shopify reports the image FAILED. Review the retained media errors before another image.'
            : payload.reconciliation.effectState === 'unknown'
              ? 'The expired provider attempt is terminal unknown and will never be repeated automatically.'
              : 'Shopify media processing is still in progress. No provider write was repeated.',
      )
    } catch (statusError) {
      setError(
        statusError instanceof Error
          ? statusError.message
          : 'Shopify media status did not refresh',
      )
    } finally {
      setProjecting(false)
    }
  }

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedFile) {
      setError('Choose a product image before uploading.')
      return
    }
    if (!altText.trim()) {
      setError('Describe the product image with alt text before uploading.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const form = new FormData()
      form.set('image', selectedFile)
      form.set('altText', altText.trim())
      form.set('setPrimary', String(setPrimary))
      const response = await fetch(apiPath(productId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        body: form,
      })
      const payload = (
        await response.json().catch(() => ({}))
      ) as ProductImagePayload
      const nextState = assetState(payload)
      if (!response.ok || payload.ok !== true || !nextState) {
        throw new Error(payload.error || 'Product image was not uploaded')
      }
      setState(nextState)
      setProjection(null)
      setReconciliation(null)
      setActivePublishConfirmed(false)
      setFaireProjection(null)
      setFaireReconciliation(null)
      setFairePublishConfirmed(false)
      setSelectedFile(null)
      setAltText('')
      setSetPrimary(false)
      if (fileInput.current) fileInput.current.value = ''
      setNotice(
        setPrimary || nextState.assets.length === 1
          ? 'Product image uploaded and set as primary.'
          : 'Product image revision uploaded.',
      )
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : 'Product image was not uploaded',
      )
    } finally {
      setSaving(false)
    }
  }

  const makePrimary = async (asset: ProductImageAsset) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(apiPath(productId), {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'set-primary',
          assetId: asset.id,
          expectedRowVersion: asset.rowVersion,
        }),
      })
      const payload = (
        await response.json().catch(() => ({}))
      ) as ProductImagePayload
      const nextState = assetState(payload)
      if (!response.ok || payload.ok !== true || !nextState) {
        throw new Error(payload.error || 'Primary product image was not changed')
      }
      setState(nextState)
      setProjection(null)
      setReconciliation(null)
      setActivePublishConfirmed(false)
      setFaireProjection(null)
      setFaireReconciliation(null)
      setFairePublishConfirmed(false)
      setNotice(`Image revision ${asset.assetRevision} is now primary.`)
    } catch (primaryError) {
      setError(
        primaryError instanceof Error
          ? primaryError.message
          : 'Primary product image was not changed',
      )
    } finally {
      setSaving(false)
    }
  }

  const projectToShopify = async (executeProviderWrite: boolean) => {
    if (!selectedShopifyChannel || !selectedShopifyAsset) {
      setError('Choose an exact Shopify listing and image revision.')
      return
    }
    const selectedChannel = selectedChannelEvidence
    const selectedAsset = selectedAssetEvidence
    if (!selectedChannel || !selectedAsset || !state?.product) {
      setError('Refresh and choose an exact Shopify listing and image revision.')
      return
    }
    if (
      executeProviderWrite
      && (!activePublishConfirmed || !exactShadowSimulation)
    ) {
      setError(
        'Run the exact zero-write Shadow simulation, then confirm this one Product, listing, and image revision.',
      )
      return
    }
    setProjecting(true)
    setError('')
    setNotice('')
    setProjection(null)
    try {
      const response = await fetch(
        `/api/crm/products/${encodeURIComponent(productId)}/shopify-product-image`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'publish-product-image',
            assetId: selectedShopifyAsset,
            channelStateGlobalId: selectedShopifyChannel,
            executeProviderWrite,
            expectedProductReferenceCode: state.product.referenceCode,
            expectedChannelStateRowVersion: selectedChannel.rowVersion,
            expectedChannelSourceRevision:
              selectedChannel.sourceRevision,
            expectedAssetRevision: selectedAsset.assetRevision,
            expectedAssetRowVersion: selectedAsset.rowVersion,
            expectedAssetContentSha256:
              selectedAsset.contentSha256,
            shadowSimulationEffectGlobalId: executeProviderWrite
              ? exactShadowSimulation!.externalEffect.globalId
              : null,
          }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as ShopifyProductImageProjectionPayload
      if (!response.ok || payload.ok !== true || !payload.publication) {
        throw new Error(
          payload.error || 'Shopify product image command did not complete',
        )
      }
      setProjection(payload.publication)
      setNotice(
        payload.publication.mode === 'shadow'
          ? 'Shadow simulation recorded. Shopify received zero writes.'
          : payload.publication.mediaPublication.ready
            ? 'Shopify accepted the image and reports the media ready. Featured position is not yet changed.'
            : 'Shopify accepted the image publish command. Media readiness is tracked separately.',
      )
    } catch (projectionError) {
      setError(
        projectionError instanceof Error
          ? projectionError.message
          : 'Shopify product image command did not complete',
      )
    } finally {
      setProjecting(false)
    }
  }

  const refreshFromFaire = async () => {
    if (state?.imageImportAvailable !== true) {
      setError(
        'Faire Product image import is unavailable while commerce reconciliation is disabled.',
      )
      return
    }
    if (!selectedFaireManualReadAllowed) {
      setError(
        selectedFaireStoreSync?.effectiveReasonLabel
          || 'The selected Faire connection is unavailable for an explicit provider read.',
      )
      return
    }
    const channel = selectedFaireChannelEvidence
    if (!channel || !state?.product) {
      setError('Refresh and choose one exact mapped Faire listing.')
      return
    }
    if (!channel.providerSku) {
      setError('The selected Faire listing has no exact SKU evidence.')
      return
    }
    setRefreshingFaire(true)
    setError('')
    setNotice('')
    try {
      const command = {
        action: 'refresh-faire-product-images' as const,
        channelStateGlobalId: channel.globalId,
        expectedProductReferenceCode: state.product.referenceCode,
        expectedIntegrationAccountGlobalId:
          channel.integrationAccountGlobalId,
        expectedChannelStateRowVersion: channel.rowVersion,
        expectedChannelSourceRevision: channel.sourceRevision,
        expectedExternalProductId: channel.externalProductId,
        expectedExternalVariantId: channel.externalVariantId,
        expectedProviderSku: channel.providerSku,
        confirmReadOnlyProviderRequest: true as const,
      }
      const fingerprint = JSON.stringify(command)
      if (pendingFaireRefresh.current?.fingerprint !== fingerprint) {
        pendingFaireRefresh.current = {
          fingerprint,
          idempotencyKey:
            `faire-product-image-refresh:${globalThis.crypto.randomUUID()}`,
        }
      }
      const idempotencyKey = pendingFaireRefresh.current.idempotencyKey
      const response = await fetch(
        `/api/crm/products/${encodeURIComponent(productId)}/faire-product-images`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...command, idempotencyKey }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as FaireProductImageRefreshPayload
      if (!response.ok || payload.ok !== true || !payload.refresh) {
        if (response.status >= 400 && response.status < 500) {
          pendingFaireRefresh.current = null
        }
        throw new Error(
          payload.error || 'Faire Product images were not refreshed',
        )
      }
      pendingFaireRefresh.current = null
      const queued = Number(payload.refresh.jobs.queued || 0)
      const succeeded = Number(payload.refresh.jobs.succeeded || 0)
      await load()
      setNotice(
        payload.refresh.observedImages === 0
          ? 'Faire returned no importable images. No removal was inferred and Faire received zero writes.'
          : queued > 0
            ? `${payload.refresh.observedImages} current Faire image${payload.refresh.observedImages === 1 ? '' : 's'} observed; ${queued} queued for background import. Faire received zero writes.`
            : succeeded > 0
              ? `${succeeded} Faire image import${succeeded === 1 ? '' : 's'} already succeeded. Faire received zero writes.`
              : `${payload.refresh.observedImages} current Faire image${payload.refresh.observedImages === 1 ? '' : 's'} reconciled. Faire received zero writes.`,
      )
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Faire Product images were not refreshed',
      )
    } finally {
      setRefreshingFaire(false)
    }
  }

  const projectToFaire = async (executeProviderWrite: boolean) => {
    const channel = selectedFaireChannelEvidence
    const asset = selectedFaireAssetEvidence
    if (!channel || !asset || !state?.product) {
      setError('Choose one exact Faire listing and primary image revision.')
      return
    }
    if (
      executeProviderWrite
      && (!fairePublishConfirmed || !exactFaireShadowSimulation)
    ) {
      setError(
        'Run the exact zero-write Faire Shadow simulation, then confirm the two-call publication once.',
      )
      return
    }
    setPublishingFaire(true)
    setError('')
    setNotice('')
    if (!executeProviderWrite) setFaireProjection(null)
    setFaireReconciliation(null)
    try {
      const response = await fetch(
        faireProductImagePath(productId),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'publish-product-image',
            assetId: asset.id,
            channelStateGlobalId: channel.globalId,
            executeProviderWrite,
            expectedProductReferenceCode: state.product.referenceCode,
            expectedChannelStateRowVersion: channel.rowVersion,
            expectedChannelSourceRevision: channel.sourceRevision,
            expectedAssetRevision: asset.assetRevision,
            expectedAssetRowVersion: asset.rowVersion,
            expectedAssetContentSha256: asset.contentSha256,
            shadowSimulationEffectGlobalId: executeProviderWrite
              ? exactFaireShadowSimulation!.externalEffect.globalId
              : null,
          }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as FaireProductImageProjectionPayload
      if (!response.ok || payload.ok !== true || !payload.publication) {
        if (
          executeProviderWrite
          && typeof payload.externalEffectGlobalId === 'string'
          && /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/.test(
            payload.externalEffectGlobalId,
          )
        ) {
          setFaireProjection({
            productReferenceCode: state.product.referenceCode,
            channelStateGlobalId: channel.globalId,
            imageAssetId: asset.id,
            imageAssetRevision: asset.assetRevision,
            imageContentSha256: asset.contentSha256,
            mode: 'active',
            replayed: false,
            providerMutation: {
              accepted: false,
              writeCount: 0,
              uploadAccepted: false,
              attachmentAccepted: false,
            },
            images: {
              existingPreserved: true,
              priorCount: null,
              projectedCount: null,
              uploadedLocatorSha256: null,
            },
            externalEffect: {
              globalId: payload.externalEffectGlobalId,
              state: 'reconciliation_required',
              providerWriteCount: 0,
            },
          })
          setNotice(
            'The Faire effect identity was retained. Reconcile by provider readback; the provider writes will not be repeated.',
          )
        }
        throw new Error(
          payload.error || 'Faire Product-image command did not complete',
        )
      }
      setFaireProjection(payload.publication)
      setNotice(
        payload.publication.mode === 'shadow'
          ? 'Faire Shadow simulation recorded with zero provider requests and zero writes.'
          : payload.publication.externalEffect.state === 'succeeded'
            ? `Faire accepted the upload and exact Product attachment. ${payload.publication.images.priorCount || 0} existing image${payload.publication.images.priorCount === 1 ? '' : 's'} preserved.`
            : 'Faire publication is terminal unknown and will not be retried. Use provider readback reconciliation.',
      )
    } catch (publishError) {
      setError(
        publishError instanceof Error
          ? publishError.message
          : 'Faire Product-image command did not complete',
      )
    } finally {
      if (executeProviderWrite) void loadFaireRecoveryEffects()
      setPublishingFaire(false)
    }
  }

  const reconcileFaireImage = async (selectedEffectGlobalId?: string) => {
    const externalEffectGlobalId = selectedEffectGlobalId
      || (faireProjection?.mode === 'active'
        ? faireProjection.externalEffect.globalId
        : '')
    if (!EFFECT_GLOBAL_ID.test(externalEffectGlobalId)) return
    setPublishingFaire(true)
    setReconcilingFaireEffect(externalEffectGlobalId)
    setError('')
    setNotice('')
    try {
      const response = await fetch(
        faireProductImagePath(productId),
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'reconcile-product-image',
            externalEffectGlobalId,
          }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as FaireProductImageProjectionPayload
      if (!response.ok || payload.ok !== true || !payload.reconciliation) {
        throw new Error(
          payload.error || 'Faire Product-image readback did not complete',
        )
      }
      setFaireReconciliation(payload.reconciliation)
      if (payload.reconciliation.terminalized) {
        setFaireProjection((current) => current
          && current.externalEffect.globalId === externalEffectGlobalId
          ? {
            ...current,
            providerMutation: {
              accepted: true,
              writeCount: 2,
              uploadAccepted: true,
              attachmentAccepted: true,
            },
            externalEffect: {
              ...current.externalEffect,
              state: 'succeeded',
              providerWriteCount: 2,
            },
          }
          : current)
      }
      setNotice(
        payload.reconciliation.confirmedApplied
          ? 'Faire readback confirms the exact uploaded image is attached. The uncertain effect is now succeeded; no provider write was repeated.'
          : payload.reconciliation.outcome === 'observed_absent'
            ? 'Faire readback did not observe the exact uploaded image. The effect remains unknown and actionable; no provider write was repeated.'
            : payload.reconciliation.reason ===
                'ambiguous_exact_locator_matches'
              ? 'Faire returned multiple matches for the uploaded locator. The effect remains unknown and requires review; no provider write was repeated.'
              : 'Faire readback could not safely resolve the effect. It remains actionable and no provider write was repeated.',
      )
    } catch (reconcileError) {
      setError(
        reconcileError instanceof Error
          ? reconcileError.message
          : 'Faire Product-image readback did not complete',
      )
    } finally {
      await loadFaireRecoveryEffects()
      setReconcilingFaireEffect('')
      setPublishingFaire(false)
    }
  }

  return (
    <Stack spacing={1.5} data-testid="crm-product-image-panel">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        gap={1}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        justifyContent="space-between"
      >
        <Stack direction="row" gap={1} alignItems="center" minWidth={0}>
          <ImageRounded color="primary" />
          <Box minWidth={0}>
            <Typography variant="subtitle2" fontWeight={700}>
              Product images
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Immutable ClawPilot image revisions
            </Typography>
          </Box>
        </Stack>
        {canManage ? (
          <Button
            size="small"
            startIcon={loading || loadingFaireRecoveries
              ? <CircularProgress size={14} />
              : <RefreshRounded />}
            onClick={() => {
              void load()
              void loadFaireRecoveryEffects()
            }}
            disabled={loading || loadingFaireRecoveries || saving}
            sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}
          >
            Refresh
          </Button>
        ) : null}
      </Stack>

      {!canManage ? (
        <Alert severity="info">
          Only organization owners and administrators can view or manage
          stored Product images.
        </Alert>
      ) : !PRODUCT_ID_PATTERN.test(productId) ? (
        <Alert severity="warning">
          Save this Product before managing its image revisions.
        </Alert>
      ) : (
        <>
          <Alert severity="info">
            Image flow is controlled, not a live mirror. Shopify and Faire
            images import as immutable ClawPilot revisions only while commerce
            read reconciliation is enabled. Production reads require an active,
            verified production connection. A ClawPilot primary image
            queues projection to SuiteCRM; SuiteCRM changes return as immutable
            revisions and remain secondary when an independently governed
            primary exists. Sending an image to Shopify or Faire always
            requires an exact Shadow simulation and one-use authorization.
          </Alert>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {notice ? <Alert severity="success">{notice}</Alert> : null}

          <Box
            component="form"
            onSubmit={(event) => void upload(event)}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              p: 1.5,
              minWidth: 0,
            }}
          >
            <Stack spacing={1.25} minWidth={0}>
              <Button
                component="label"
                variant="outlined"
                startIcon={<AddPhotoAlternateRounded />}
                disabled={saving}
                sx={{ alignSelf: 'flex-start', maxWidth: '100%' }}
              >
                Choose image
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  accept={SUPPORTED_MIME_TYPES.join(',')}
                  onChange={chooseFile}
                />
              </Button>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ overflowWrap: 'anywhere' }}
              >
                {selectedFile
                  ? `${selectedFile.name} · ${displayBytes(selectedFile.size)}`
                  : 'PNG, JPEG, or WebP · maximum 2 MB'}
              </Typography>
              <TextField
                label="Image alt text"
                required
                multiline
                minRows={2}
                value={altText}
                onChange={(event) => setAltText(event.target.value)}
                inputProps={{ maxLength: MAX_ALT_TEXT_LENGTH }}
                helperText={`${altText.length}/${MAX_ALT_TEXT_LENGTH} characters`}
                disabled={saving}
              />
              <FormControlLabel
                control={(
                  <Checkbox
                    checked={setPrimary}
                    onChange={(event) => setSetPrimary(event.target.checked)}
                    disabled={saving}
                  />
                )}
                label="Make this the primary Product image"
              />
              <Button
                type="submit"
                variant="contained"
                disabled={saving || !selectedFile || !altText.trim()}
                startIcon={saving ? <CircularProgress size={16} /> : undefined}
                sx={{ alignSelf: 'flex-start' }}
              >
                {saving ? 'Uploading…' : 'Upload revision'}
              </Button>
            </Stack>
          </Box>

          <Box>
            <Typography variant="subtitle2" fontWeight={700}>
              Stored revisions
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {state?.assets.length || 0} immutable image
              {(state?.assets.length || 0) === 1 ? '' : 's'}
            </Typography>
          </Box>

          {loading ? (
            <Stack direction="row" gap={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Loading Product image revisions…
              </Typography>
            </Stack>
          ) : state?.assets.length ? (
            <Stack spacing={1}>
              {state.assets.map((asset) => (
                <Box
                  key={asset.id}
                  sx={{
                    border: '1px solid',
                    borderColor: asset.isPrimary
                      ? 'primary.main'
                      : 'divider',
                    borderRadius: 1,
                    p: 1.25,
                    minWidth: 0,
                  }}
                >
                  <Stack spacing={0.75} minWidth={0}>
                    <Box
                      component="img"
                      src={`${apiPath(productId)}/${encodeURIComponent(asset.id)}`}
                      alt={asset.altText}
                      loading="lazy"
                      sx={{
                        display: 'block',
                        width: '100%',
                        maxWidth: 280,
                        maxHeight: 280,
                        objectFit: 'contain',
                        borderRadius: 1,
                        bgcolor: 'background.default',
                      }}
                    />
                    <Stack
                      direction="row"
                      gap={0.75}
                      alignItems="center"
                      flexWrap="wrap"
                    >
                      <Chip
                        size="small"
                        label={`Revision ${asset.assetRevision}`}
                        variant="outlined"
                      />
                      {asset.isPrimary ? (
                        <Chip
                          size="small"
                          color="primary"
                          icon={<StarRounded />}
                          label="Primary"
                        />
                      ) : null}
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Row v${asset.rowVersion}`}
                      />
                    </Stack>
                    <Typography variant="body2" fontWeight={600}>
                      {asset.altText}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ overflowWrap: 'anywhere' }}
                    >
                      {displayMimeType(asset.mimeType)} · {asset.pixelWidth} ×{' '}
                      {asset.pixelHeight} px · {displayBytes(asset.byteLength)}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        fontFamily: 'monospace',
                        overflowWrap: 'anywhere',
                      }}
                      title={asset.contentSha256}
                    >
                      SHA-256 {hashPrefix(asset.contentSha256)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {displaySource(asset.source)}
                    </Typography>
                    {!asset.isPrimary ? (
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<StarRounded />}
                        onClick={() => void makePrimary(asset)}
                        disabled={saving}
                        sx={{ alignSelf: 'flex-start' }}
                      >
                        Set as primary
                      </Button>
                    ) : null}
                  </Stack>
                </Box>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No Product image revisions are stored yet.
            </Typography>
          )}

          <Divider />
          <Stack spacing={1.25} data-testid="crm-faire-image-import">
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                Faire image import
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Re-read one exact mapped Faire Product and queue its current
                images for ClawPilot import. The bounded operation makes two
                read-only Faire requests—current brand profile and exact
                Product—and cannot write to Faire.
              </Typography>
            </Box>

            {faireChannels.length === 0 ? (
              <Alert severity="info">
                Map this Product to an active Faire listing before importing
                images.
              </Alert>
            ) : null}

            {state?.imageImportAvailable === false ? (
              <Alert severity="warning">
                Automatic provider-image import is disabled in this
                environment. No Faire read or image job will be attempted.
              </Alert>
            ) : null}

            {selectedFaireChannelEvidence
            && selectedFaireStoreSyncNormallyPaused ? (
              <Alert severity="info">
                {selectedFaireStoreSync?.effectiveReasonLabel}
                {' '}Automatic Store sync remains paused, while this explicit
                owner or administrator refresh remains available. It performs
                only the bounded read-only requests shown above and makes zero
                Faire writes.
              </Alert>
            ) : null}

            {selectedFaireChannelEvidence
            && !selectedFaireManualReadAllowed ? (
              <Alert severity="warning">
                {selectedFaireStoreSync?.effectiveReasonLabel
                  || 'This Faire connection is unavailable.'}
                {' '}Existing mirrored images remain available, but this exact
                provider read is blocked until the emergency override or
                connection issue is resolved.
              </Alert>
            ) : null}

            <TextField
              select
              fullWidth
              label="Faire listing"
              value={selectedFaireChannel}
              onChange={(event) => setSelectedFaireChannel(event.target.value)}
              disabled={
                refreshingFaire
                || faireChannels.length === 0
                || state?.imageImportAvailable !== true
              }
            >
              {faireChannels.map((channel) => (
                <MenuItem key={channel.globalId} value={channel.globalId}>
                  {channel.integrationAccountName} ·{' '}
                  {channel.providerProductTitle}
                  {channel.providerVariantTitle
                    ? ` · ${channel.providerVariantTitle}`
                    : ''}
                  {' · '}
                  {channel.providerSku || 'No SKU'}
                </MenuItem>
              ))}
            </TextField>

            <Alert severity="info">
              The server revalidates the Product reference, Faire account,
              listing, variant, SKU, channel revision, and credential
              generation before recording any image observation. Missing
              images are not treated as removals by this targeted refresh.
            </Alert>
            <Button
              variant="outlined"
              startIcon={refreshingFaire
                ? <CircularProgress size={16} />
                : <RefreshRounded />}
              onClick={() => void refreshFromFaire()}
              disabled={
                refreshingFaire
                || state?.imageImportAvailable !== true
                || !selectedFaireManualReadAllowed
                || !selectedFaireChannelEvidence
                || !selectedFaireChannelEvidence.providerSku
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              {refreshingFaire
                ? 'Reading exact Faire Product…'
                : 'Refresh and import from Faire'}
            </Button>
          </Stack>

          <Divider />
          <Stack spacing={1.25} data-testid="crm-faire-image-publishing">
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                Faire image publishing
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Publish one immutable ClawPilot primary image to one exact
                mapped Faire Product. Faire requires two provider writes: an
                image upload followed by an exact Product-image attachment.
                Current Faire images are preserved.
              </Typography>
            </Box>

            {loadingFaireRecoveries ? (
              <Alert severity="info" icon={<CircularProgress size={18} />}>
                Checking this Product for durable Faire image recovery records…
              </Alert>
            ) : null}
            {faireRecoveryError ? (
              <Alert
                severity="warning"
                action={(
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => void loadFaireRecoveryEffects()}
                    disabled={loadingFaireRecoveries}
                  >
                    Retry
                  </Button>
                )}
              >
                Recovery status is unavailable: {faireRecoveryError}
              </Alert>
            ) : null}
            {faireRecoveryEffects.length > 0 ? (
              <Stack
                spacing={1.25}
                data-testid="crm-faire-image-recovery"
                sx={{
                  border: 1,
                  borderColor: 'warning.main',
                  borderRadius: 1,
                  p: 1.5,
                }}
              >
                <Alert severity="warning">
                  Unresolved Faire image publication evidence was recovered for
                  this Product. These records survive page reloads and new
                  operator sessions. Recovery cannot repeat the image upload or
                  Product attachment.
                </Alert>
                {faireRecoveryEffects.map((effect) => (
                  <Stack
                    key={effect.externalEffectGlobalId}
                    spacing={0.75}
                    sx={{
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 1,
                      p: 1.25,
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      gap={0.75}
                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                    >
                      <Chip
                        size="small"
                        color="warning"
                        label={effect.recoveryState === 'expired_claim'
                          ? 'Expired claim · recovery required'
                          : 'Unknown · recovery required'}
                      />
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        Effect {effect.externalEffectGlobalId}
                      </Typography>
                    </Stack>
                    <Typography variant="body2">
                      Product {effect.productReferenceCode} · listing{' '}
                      {effect.channelStateGlobalId} · image revision{' '}
                      {effect.assetRevision} · {effect.assetAltText}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {effect.providerWriteCount} known provider write
                      {effect.providerWriteCount === 1 ? '' : 's'} · exact
                      upload fingerprint {effect.uploadedLocatorAvailable
                        ? 'available'
                        : 'unavailable'} · recorded{' '}
                      {new Date(effect.occurredAt).toLocaleString()}
                      {effect.latestOutcome
                        ? ` · latest ${effect.latestOutcome.replaceAll('_', ' ')}`
                        : ''}
                      {effect.errorCode ? ` · ${effect.errorCode}` : ''}
                    </Typography>
                    <Alert
                      severity={effect.reconciliationEligibility ===
                        'readback_terminalizable'
                        ? 'info'
                        : 'warning'}
                    >
                      {effect.reconciliationEligibility ===
                      'readback_terminalizable'
                        ? 'Eligible for exact read-only Faire readback: '
                        : 'Manual review only: '}
                      {faireRecoveryReason(effect.reconciliationReason)}.
                    </Alert>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={
                        reconcilingFaireEffect === effect.externalEffectGlobalId
                          ? <CircularProgress size={14} />
                          : <RefreshRounded />
                      }
                      onClick={() => void reconcileFaireImage(
                        effect.externalEffectGlobalId,
                      )}
                      disabled={publishingFaire}
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      {effect.reconciliationEligibility ===
                      'readback_terminalizable'
                        ? 'Reconcile by read-only Faire readback'
                        : 'Record safe manual-review state'}
                    </Button>
                    <Typography variant="caption" color="text.secondary">
                      This action is fenced to this Product and exact effect. It
                      performs zero provider writes.
                      {effect.reconciliationEligibility ===
                      'readback_terminalizable'
                        ? ' It reads the current Faire Product image set and terminalizes only an exact single-locator match.'
                        : ' It records the durable manual-review decision without contacting Faire or terminalizing the effect.'}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            ) : null}

            {faireChannels.length === 0 ? (
              <Alert severity="info">
                Map this Product to an active Faire listing before publishing
                an image.
              </Alert>
            ) : null}

            <TextField
              select
              fullWidth
              label="Faire listing to publish"
              value={selectedFaireChannel}
              onChange={(event) => {
                setSelectedFaireChannel(event.target.value)
                setFaireProjection(null)
                setFaireReconciliation(null)
                setFairePublishConfirmed(false)
              }}
              disabled={publishingFaire || faireChannels.length === 0}
            >
              {faireChannels.map((channel) => (
                <MenuItem key={channel.globalId} value={channel.globalId}>
                  {channel.integrationAccountName} ·{' '}
                  {channel.providerProductTitle}
                  {channel.providerVariantTitle
                    ? ` · ${channel.providerVariantTitle}`
                    : ''}
                  {' · '}
                  {channel.globalId}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              fullWidth
              label="ClawPilot primary image revision"
              value={selectedFaireAsset}
              onChange={(event) => {
                setSelectedFaireAsset(event.target.value)
                setFaireProjection(null)
                setFaireReconciliation(null)
                setFairePublishConfirmed(false)
              }}
              disabled={publishingFaire || !state?.assets.length}
            >
              {(state?.assets || [])
                .filter((asset) => asset.isPrimary)
                .map((asset) => (
                  <MenuItem key={asset.id} value={asset.id}>
                    Revision {asset.assetRevision} · ClawPilot primary ·{' '}
                    {asset.altText}
                  </MenuItem>
                ))}
            </TextField>

            <Alert severity="info">
              Shadow performs the exact account, Product, listing, mapping,
              image, credential, OAuth-scope, and idempotency checks with zero
              Faire network requests and zero provider writes.
            </Alert>
            <Button
              variant="outlined"
              onClick={() => void projectToFaire(false)}
              disabled={
                publishingFaire
                || !selectedFaireChannelEvidence
                || !selectedFaireAssetEvidence
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              {publishingFaire ? 'Running…' : 'Simulate Faire in Shadow'}
            </Button>

            <Alert severity="warning">
              This one-use authorization permits only the selected Faire
              account, Product, mapped listing, and primary image revision.
              Operations remains globally Shadow. If either provider call has
              an uncertain outcome, neither call is retried automatically.
            </Alert>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={fairePublishConfirmed}
                  onChange={(event) => setFairePublishConfirmed(
                    event.target.checked,
                  )}
                  disabled={
                    publishingFaire
                    || !exactFaireShadowSimulation
                  }
                />
              )}
              label="I authorize the two required Faire provider writes once for this exact Product, listing, and image revision"
            />
            <Button
              color="warning"
              variant="contained"
              onClick={() => void projectToFaire(true)}
              disabled={
                publishingFaire
                || !fairePublishConfirmed
                || !exactFaireShadowSimulation
                || !selectedFaireChannelEvidence
                || !selectedFaireAssetEvidence
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              {publishingFaire
                ? 'Publishing exact Faire image…'
                : 'Publish this image to Faire once'}
            </Button>

            {faireProjection ? (
              <Alert severity={
                faireProjection.mode === 'shadow'
                  ? 'info'
                  : faireProjection.externalEffect.state === 'succeeded'
                    ? 'success'
                    : 'warning'
              }>
                {faireProjection.mode === 'shadow'
                  ? 'Shadow simulation'
                  : 'One-use Faire publication'}
                {' · '}
                {faireProjection.externalEffect.state}
                {' · '}
                {faireProjection.externalEffect.providerWriteCount} known
                provider write{faireProjection.externalEffect.providerWriteCount === 1 ? '' : 's'}
                {faireProjection.images.priorCount !== null
                  ? ` · ${faireProjection.images.priorCount} prior image${faireProjection.images.priorCount === 1 ? '' : 's'} preserved`
                  : ''}
              </Alert>
            ) : null}
            {faireProjection?.mode === 'active'
              && faireProjection.externalEffect.state !== 'succeeded'
              && !faireRecoveryEffects.some(
                (effect) => effect.externalEffectGlobalId
                  === faireProjection.externalEffect.globalId,
              ) ? (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={publishingFaire
                    ? <CircularProgress size={14} />
                    : <RefreshRounded />}
                  onClick={() => void reconcileFaireImage()}
                  disabled={publishingFaire}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Reconcile by Faire readback
                </Button>
              ) : null}
            {faireReconciliation ? (
              <Alert severity={
                faireReconciliation.confirmedApplied
                  ? 'success'
                  : 'warning'
              }>
                Recovery {faireReconciliation.outcome.replaceAll('_', ' ')}
                {faireReconciliation.providerImageCount !== undefined
                  ? ` · ${faireReconciliation.providerImageCount} current provider image${faireReconciliation.providerImageCount === 1 ? '' : 's'}`
                  : ''}
                {' · no provider write repeated'}
              </Alert>
            ) : null}
          </Stack>

          <Divider />
          <Stack spacing={1.25} data-testid="crm-shopify-image-publishing">
            <Box>
              <Typography variant="subtitle2" fontWeight={700}>
                Shopify image publishing
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Select one exact listing and one immutable ClawPilot image
                revision. Publishing adds media to Shopify; it does not claim
                the image is featured until Shopify reports it ready and a
                separate reorder completes.
              </Typography>
            </Box>

            {shopifyChannels.length === 0 ? (
              <Alert severity="info">
                Map this Product to a Shopify listing before publishing an
                image.
              </Alert>
            ) : null}

            <TextField
              select
              fullWidth
              label="Shopify listing"
              value={selectedShopifyChannel}
              onChange={(event) => {
                setSelectedShopifyChannel(event.target.value)
                setProjection(null)
                setReconciliation(null)
                setActivePublishConfirmed(false)
              }}
              disabled={projecting || shopifyChannels.length === 0}
            >
              {shopifyChannels.map((channel) => (
                <MenuItem key={channel.globalId} value={channel.globalId}>
                  {channel.integrationAccountName} ·{' '}
                  {channel.providerProductTitle}
                  {channel.providerVariantTitle
                    ? ` · ${channel.providerVariantTitle}`
                    : ''}
                  {' · '}
                  {channel.globalId}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              fullWidth
              label="ClawPilot image revision"
              value={selectedShopifyAsset}
              onChange={(event) => {
                setSelectedShopifyAsset(event.target.value)
                setProjection(null)
                setReconciliation(null)
                setActivePublishConfirmed(false)
              }}
              disabled={projecting || !state?.assets.length}
            >
              {(state?.assets || [])
                .filter((asset) => asset.isPrimary)
                .map((asset) => (
                <MenuItem key={asset.id} value={asset.id}>
                  Revision {asset.assetRevision}
                  {' · ClawPilot primary'}
                  {' · '}
                  {asset.altText}
                </MenuItem>
                ))}
            </TextField>

            <Alert severity="info">
              Shadow runs the full selection, revision, credential, and
              idempotency checks while guaranteeing zero Shopify writes.
            </Alert>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              gap={1}
              alignItems={{ xs: 'stretch', sm: 'center' }}
            >
              <Button
                variant="outlined"
                onClick={() => void projectToShopify(false)}
                disabled={
                  projecting
                  || !selectedShopifyChannel
                  || !selectedShopifyAsset
                }
              >
                {projecting ? 'Running…' : 'Simulate in Shadow'}
              </Button>
            </Stack>

            <Alert severity="warning">
              One-resource authorization publishes only the selected ClawPilot
              Product, exact Shopify listing, and exact primary image revision.
              Operations stays globally Shadow. This authority cannot be used
              for another Product, listing, image, category, or bulk update.
            </Alert>
            <FormControlLabel
              control={(
                <Checkbox
                  checked={activePublishConfirmed}
                  onChange={(event) => setActivePublishConfirmed(
                    event.target.checked,
                  )}
                  disabled={
                    projecting
                    || !exactShadowSimulation
                  }
                />
              )}
              label="I authorize one provider write for this exact Product, listing, and image revision only"
            />
            <Button
              color="warning"
              variant="contained"
              onClick={() => void projectToShopify(true)}
              disabled={
                projecting
                || !activePublishConfirmed
                || !exactShadowSimulation
                || !selectedShopifyChannel
                || !selectedShopifyAsset
              }
              sx={{ alignSelf: 'flex-start' }}
            >
              {projecting
                ? 'Publishing exact image…'
                : 'Publish this exact image once'}
            </Button>

            {projection ? (
              <Alert
                severity={projection.mode === 'shadow' ? 'info' : 'success'}
              >
                {projection.mode === 'shadow'
                  ? 'Shadow simulation'
                  : 'One-resource provider command'}
                {' · '}
                {projection.externalEffect.state}
                {' · '}
                {projection.externalEffect.providerWriteCount} provider
                {' '}
                {projection.externalEffect.providerWriteCount === 1
                  ? 'write'
                  : 'writes'}
                {projection.replayed ? ' · idempotent replay' : ''}
                {projection.mediaPublication.status
                  ? ` · media ${projection.mediaPublication.status.toLowerCase()}`
                  : ''}
                {projection.mediaPublication.primaryPositionConfirmed
                  ? ' · featured position confirmed'
                  : ' · featured position not changed'}
              </Alert>
            ) : null}
            {projection?.mode === 'active' ? (
              <Button
                size="small"
                variant="outlined"
                startIcon={projecting
                  ? <CircularProgress size={14} />
                  : <RefreshRounded />}
                onClick={() => void refreshShopifyMediaStatus()}
                disabled={projecting}
                sx={{ alignSelf: 'flex-start' }}
              >
                Refresh Shopify media status
              </Button>
            ) : null}
            {reconciliation ? (
              <Alert
                severity={reconciliation.ready
                  ? 'success'
                  : reconciliation.status === 'FAILED'
                    || reconciliation.effectState === 'unknown'
                    ? 'warning'
                    : 'info'}
              >
                Media {reconciliation.status?.toLowerCase() || 'unresolved'}
                {' · '}
                {reconciliation.providerWriteCount} provider writes during
                reconciliation
                {' · '}
                {reconciliation.terminal ? 'terminal' : 'not terminal'}
                {reconciliation.errors.length
                  ? ` · ${reconciliation.errors.length} retained media error${reconciliation.errors.length === 1 ? '' : 's'}`
                  : ''}
              </Alert>
            ) : null}
          </Stack>
        </>
      )}
    </Stack>
  )
}
