export const WEARABLE_PICK_QUEUE_SCHEMA_VERSION = 1 as const

export type WearablePickTask = {
  pickTaskGlobalId: string
  sequence: number
  productGlobalId: string
  productName: string
  channelSku: string
  productImageURL: string | null
  barcode: string | null
  locationCode: string
  warehouseGlobalId?: string
  locationGlobalId?: string
  locationBarcode?: string
  locationScanRequired?: true
  locationScanPolicyRowVersion?: number
  quantity: number
}

export type WearableScanSource = 'iphone_camera' | 'meta'

export type WearableScanObservationInput = {
  barcode: string
  capturedAt: string
  source: WearableScanSource
}

export type WearablePickTaskScanEvidenceInput = {
  pickTaskGlobalId: string
  policyRowVersion: number
  location: WearableScanObservationInput
  product: WearableScanObservationInput
}

export type WearablePickOrder = {
  orderGlobalId: string
  orderNumber: string
  rowVersion: number
  tasks: WearablePickTask[]
}

export type WearablePickQueue = {
  schemaVersion: typeof WEARABLE_PICK_QUEUE_SCHEMA_VERSION
  organizationId: string
  workerEmail: string
  generatedAt: string
  orders: WearablePickOrder[]
}
