export class FaireProductImageRefreshError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'FaireProductImageRefreshError'
    this.code = code
    this.status = status
  }
}

export type FaireProductImageRefreshTarget = Readonly<{
  organizationId: string
  productId: string
  productReferenceCode: string
  productName: string
  integrationAccountId: string
  integrationAccountGlobalId: string
  credentialGeneration: number
  channelStateGlobalId: string
  channelStateRowVersion: number
  channelSourceRevision: string
  externalProductId: string
  externalVariantId: string
  providerSku: string
}>
