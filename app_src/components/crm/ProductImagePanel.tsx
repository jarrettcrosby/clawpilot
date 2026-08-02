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
  source: 'manual_upload' | 'provider_import' | 'migration'
  isPrimary: boolean
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

type ProductImageState = {
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

const PRODUCT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_ALT_TEXT_LENGTH = 500

function apiPath(productId: string) {
  return `/api/crm/products/${encodeURIComponent(productId)}/images`
}

function assetState(payload: ProductImagePayload): ProductImageState | null {
  if (!payload.product || !Array.isArray(payload.assets)) return null
  return {
    product: payload.product,
    assets: payload.assets,
  }
}

function displayMimeType(mimeType: ProductImageAsset['mimeType']) {
  if (mimeType === 'image/jpeg') return 'JPEG'
  if (mimeType === 'image/webp') return 'WebP'
  return 'PNG'
}

function displayBytes(byteLength: number) {
  if (byteLength >= 1024 * 1024) {
    return `${(byteLength / (1024 * 1024)).toFixed(2)} MB`
  }
  return `${Math.max(1, Math.round(byteLength / 1024))} KB`
}

function displaySource(source: ProductImageAsset['source']) {
  if (source === 'provider_import') return 'Provider import'
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
  const [state, setState] = useState<ProductImageState | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [altText, setAltText] = useState('')
  const [setPrimary, setSetPrimary] = useState(true)
  const [selectedShopifyChannel, setSelectedShopifyChannel] = useState('')
  const [selectedShopifyAsset, setSelectedShopifyAsset] = useState('')
  const [selectedFaireChannel, setSelectedFaireChannel] = useState('')
  const [activePublishConfirmed, setActivePublishConfirmed] = useState(false)
  const [projection, setProjection] =
    useState<ShopifyProductImageProjection | null>(null)
  const [reconciliation, setReconciliation] =
    useState<NonNullable<
      ShopifyProductImageProjectionPayload['reconciliation']
    > | null>(null)
  const [loading, setLoading] = useState(canManage)
  const [saving, setSaving] = useState(false)
  const [projecting, setProjecting] = useState(false)
  const [refreshingFaire, setRefreshingFaire] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

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
    setActivePublishConfirmed(false)
    setProjection(null)
    setReconciliation(null)
    setNotice('')
    setError('')
    if (fileInput.current) fileInput.current.value = ''
    void load()
  }, [load])

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

  const selectedChannelEvidence = shopifyChannels.find(
    (channel) => channel.globalId === selectedShopifyChannel,
  ) || null
  const selectedAssetEvidence = state?.assets.find(
    (asset) => asset.id === selectedShopifyAsset,
  ) || null
  const selectedFaireChannelEvidence = faireChannels.find(
    (channel) => channel.globalId === selectedFaireChannel,
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
      const response = await fetch(
        `/api/crm/products/${encodeURIComponent(productId)}/faire-product-images`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'refresh-faire-product-images',
            channelStateGlobalId: channel.globalId,
            expectedProductReferenceCode: state.product.referenceCode,
            expectedIntegrationAccountGlobalId:
              channel.integrationAccountGlobalId,
            expectedChannelStateRowVersion: channel.rowVersion,
            expectedChannelSourceRevision: channel.sourceRevision,
            expectedExternalProductId: channel.externalProductId,
            expectedExternalVariantId: channel.externalVariantId,
            expectedProviderSku: channel.providerSku,
            confirmReadOnlyProviderRequest: true,
          }),
        },
      )
      const payload = (
        await response.json().catch(() => ({}))
      ) as FaireProductImageRefreshPayload
      if (!response.ok || payload.ok !== true || !payload.refresh) {
        throw new Error(
          payload.error || 'Faire Product images were not refreshed',
        )
      }
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
            startIcon={loading
              ? <CircularProgress size={14} />
              : <RefreshRounded />}
            onClick={() => void load()}
            disabled={loading || saving}
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
            Uploads are retained as immutable originals. Changing the primary
            image selects a revision; it does not overwrite or delete another
            file.
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

            <TextField
              select
              fullWidth
              label="Faire listing"
              value={selectedFaireChannel}
              onChange={(event) => setSelectedFaireChannel(event.target.value)}
              disabled={refreshingFaire || faireChannels.length === 0}
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
