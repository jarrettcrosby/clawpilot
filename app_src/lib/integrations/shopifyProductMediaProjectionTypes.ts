export type ShopifyProductMediaProjectionMode = 'shadow' | 'active'

export type ShopifyProductMediaProjectionGrant = {
  id: string
  organizationId: string
  integrationAccountId: string
  integrationAccountGlobalId: string
  pipelineId: string
  productId: string
  channelStateId: string
  imageAssetId: string
  idempotencyKey: string
  productWriteAuthorizationId: string | null
  mode: ShopifyProductMediaProjectionMode
  publicOrigin: string
  productReferenceCode: string
  productSourceHash: string
  productGid: string
  channelStateGlobalId: string
  channelStateRowVersion: number
  channelSourceRevision: string
  channelSourceHash: string
  assetRevision: number
  assetRowVersion: number
  assetContentSha256: string
  assetMimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  assetByteLength: number
  assetPixelWidth: number
  assetPixelHeight: number
  assetAltText: string
  credentialGeneration: number
  activationRevision: number
  aggregateRevision: number
  aggregateHash: string
  issuedAtEpoch: number
  expiresAtEpoch: number
  createdBy: string
}

export type ShopifyProductMediaDeliveryAsset = {
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteLength: number
  contentSha256: string
}

export class ShopifyProductMediaProjectionError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ShopifyProductMediaProjectionError'
    this.code = code
    this.status = status
  }
}
