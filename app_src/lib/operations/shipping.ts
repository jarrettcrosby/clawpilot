export type ShippingTransportMode = 'parcel' | 'ltl'

export type ShippingRecordKind =
  | 'shipment_plan'
  | 'parcel_shipment'
  | 'ltl_tender'

export type ShippingRecord = {
  recordId: string
  kind: ShippingRecordKind
  transportMode: ShippingTransportMode
  orderGlobalId: string
  orderNumber: string
  referenceNumber: string
  customerName: string
  destination: string
  status: string
  carrierName: string | null
  serviceCode: string | null
  trackingNumber: string | null
  trackingNumbers: string[]
  handlingUnitCount: number
  executionMode: 'test' | 'live' | null
  standaloneOneOffPackEligible: boolean
  standaloneOneOffExecutionEligible: boolean
  occurredAt: string
}

export type ShippingWorkspace = {
  organizationId: string
  capabilities: {
    canView: boolean
    canCreate: boolean
    canPurchaseLivePostage: boolean
  }
  records: ShippingRecord[]
  pickupAvailability: {
    parcel: {
      available: false
      blocker: string
    }
    ltl: {
      available: false
      blocker: string
    }
  }
}
