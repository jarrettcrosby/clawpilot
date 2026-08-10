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
  quantity: number
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
