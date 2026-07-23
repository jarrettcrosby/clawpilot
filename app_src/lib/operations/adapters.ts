import { createHash } from 'node:crypto'
import { addCalendarDays } from '@/lib/operations/domain'
import type {
  Address,
  CarrierAdapterDescriptor,
  CarrierAddressValidationResult,
  CarrierCapability,
  CarrierLabelReconciliationResult,
  CarrierManifestResult,
  CarrierPickupResult,
  CarrierRate,
  CarrierTrackingResult,
  CarrierTransitEstimate,
  CarrierVoidResult,
  CommerceOrderInput,
  LabelResult,
  PackagePlan,
  PrintResult,
} from '@/lib/operations/types'

export interface CommerceAdapter {
  readonly provider: string
  normalizeOrder(payload: unknown): CommerceOrderInput
  updateFulfillment(input: {
    externalOrderId: string
    trackingNumber: string
    carrier: string
    shippedAt: string
    idempotencyKey: string
  }): Promise<{ accepted: boolean; providerReference: string }>
}

export interface CarrierAdapter {
  readonly descriptor: CarrierAdapterDescriptor
  supports(capability: CarrierCapability): boolean
  validateAddress?(input: {
    address: Address
    idempotencyKey: string
  }): Promise<CarrierAddressValidationResult>
  rate(input: {
    origin: Address
    destination: Address
    packages: PackagePlan[]
    requestedDeliveryAt: string
    ratedAt: string
  }): Promise<CarrierRate[]>
  estimateTransit?(input: {
    origin: Address
    destination: Address
    packages: PackagePlan[]
    shippedAt: string
    requestedDeliveryAt: string
  }): Promise<CarrierTransitEstimate[]>
  createLabel(input: {
    orderGlobalId: string
    packageGlobalId: string
    carrier: string
    serviceCode: string
    idempotencyKey: string
  }): Promise<LabelResult>
  voidLabel?(input: {
    providerLabelId: string
    trackingNumber: string
    idempotencyKey: string
  }): Promise<CarrierVoidResult>
  track?(input: {
    trackingNumber: string
  }): Promise<CarrierTrackingResult>
  createManifest?(input: {
    shipmentGlobalIds: string[]
    warehouseGlobalId: string
    idempotencyKey: string
  }): Promise<CarrierManifestResult>
  createPickup?(input: {
    warehouseGlobalId: string
    pickupAt: string
    packageCount: number
    totalWeightGrams: number
    idempotencyKey: string
  }): Promise<CarrierPickupResult>
  reconcileLabel?(input: {
    orderGlobalId: string
    packageGlobalId: string
    carrier: string
    serviceCode: string
    idempotencyKey: string
  }): Promise<CarrierLabelReconciliationResult>
}

export interface PrintAdapter {
  print(input: {
    printerGlobalId: string
    labelGlobalId: string
    format: string
    payload: string
    idempotencyKey: string
  }): Promise<PrintResult>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function stableToken(value: string, length = 12) {
  return createHash('sha256').update(value).digest('hex').slice(0, length).toUpperCase()
}

export class MockCommerceAdapter implements CommerceAdapter {
  readonly provider = 'mock-commerce'

  normalizeOrder(payload: unknown): CommerceOrderInput {
    const source = record(payload)
    const lines = Array.isArray(source.lines) ? source.lines.map(record) : []
    return {
      provider: 'mock-commerce',
      externalOrderId: text(source.externalOrderId),
      orderNumber: text(source.orderNumber),
      customerGlobalId: text(source.customerGlobalId),
      currency: text(source.currency) || 'USD',
      requestedDeliveryAt: text(source.requestedDeliveryAt),
      shipTo: record(source.shipTo) as CommerceOrderInput['shipTo'],
      lines: lines.map((line) => ({
        externalLineId: text(line.externalLineId),
        channelSku: text(line.channelSku),
        description: text(line.description),
        quantity: Number(line.quantity),
        unitPriceMinor: Number(line.unitPriceMinor),
        weightGrams: Number(line.weightGrams),
        dimensionsMm: record(line.dimensionsMm) as CommerceOrderInput['lines'][number]['dimensionsMm'],
      })),
      sourcePayload: source,
    }
  }

  async updateFulfillment(input: {
    externalOrderId: string
    trackingNumber: string
    carrier: string
    shippedAt: string
    idempotencyKey: string
  }) {
    return {
      accepted: true,
      providerReference: `mock-fulfillment-${stableToken(`${input.externalOrderId}:${input.idempotencyKey}`)}`,
    }
  }
}

export class MockCarrierAdapter implements CarrierAdapter {
  readonly descriptor: CarrierAdapterDescriptor = {
    provider: 'mock',
    adapterVersion: '1.0.0',
    environment: 'mock',
    carriers: ['USPS', 'UPS', 'FedEx', 'MockCarrier'],
    capabilities: [
      'address_validation',
      'rating',
      'transit',
      'label',
      'void',
      'tracking',
      'reconciliation',
    ],
  }

  supports(capability: CarrierCapability) {
    return this.descriptor.capabilities.includes(capability)
  }

  async validateAddress(input: {
    address: Address
    idempotencyKey: string
  }): Promise<CarrierAddressValidationResult> {
    const valid = Boolean(
      input.address.line1
      && input.address.city
      && input.address.region
      && input.address.postalCode
      && input.address.country,
    )
    return {
      valid,
      residential: null,
      normalizedAddress: valid ? { ...input.address } : null,
      suggestions: [],
      providerPayload: { mock: true, idempotencyKey: input.idempotencyKey },
    }
  }

  async rate(input: {
    origin: Address
    destination: Address
    packages: PackagePlan[]
    requestedDeliveryAt: string
    ratedAt: string
  }): Promise<CarrierRate[]> {
    const weight = input.packages.reduce((sum, item) => sum + item.weightGrams, 0)
    const weightCost = BigInt(Math.ceil(weight / 100)) * BigInt(7)
    const promise = new Date(input.requestedDeliveryAt).getTime()
    const definitions = [
      { carrier: 'USPS' as const, code: 'GROUND_ADVANTAGE', name: 'Ground Advantage', base: BigInt(725), days: 5 },
      { carrier: 'UPS' as const, code: 'GROUND', name: 'UPS Ground', base: BigInt(940), days: 4 },
      { carrier: 'FedEx' as const, code: 'FEDEX_2_DAY', name: 'FedEx 2Day', base: BigInt(1_650), days: 2 },
      { carrier: 'UPS' as const, code: 'NEXT_DAY_AIR', name: 'UPS Next Day Air', base: BigInt(2_850), days: 1 },
    ]
    return definitions.map((definition) => {
      const estimatedDeliveryAt = addCalendarDays(input.ratedAt, definition.days)
      return {
        carrier: definition.carrier,
        serviceCode: definition.code,
        serviceName: definition.name,
        internalCostMinor: definition.base + weightCost,
        transitDays: definition.days,
        estimatedDeliveryAt,
        meetsPromise: Number.isFinite(promise) && new Date(estimatedDeliveryAt).getTime() <= promise,
        providerPayload: { mock: true, originCountry: input.origin.country, destinationCountry: input.destination.country },
      }
    })
  }

  async estimateTransit(input: {
    origin: Address
    destination: Address
    packages: PackagePlan[]
    shippedAt: string
    requestedDeliveryAt: string
  }): Promise<CarrierTransitEstimate[]> {
    const rates = await this.rate({
      ...input,
      ratedAt: input.shippedAt,
    })
    return rates.map((rate) => ({
      carrier: rate.carrier,
      serviceCode: rate.serviceCode,
      serviceName: rate.serviceName,
      transitDays: rate.transitDays,
      estimatedDeliveryAt: rate.estimatedDeliveryAt,
      guaranteed: null,
      providerPayload: rate.providerPayload,
    }))
  }

  async createLabel(input: {
    orderGlobalId: string
    packageGlobalId: string
    carrier: string
    serviceCode: string
    idempotencyKey: string
  }): Promise<LabelResult> {
    const token = stableToken(`${input.orderGlobalId}:${input.packageGlobalId}:${input.idempotencyKey}`, 18)
    return {
      providerLabelId: `mock-label-${token}`,
      trackingNumber: `MOCK${token}`,
      format: 'ZPL',
      payload: `^XA^FO40,40^A0N,32,32^FD${input.orderGlobalId} ${input.carrier} ${input.serviceCode}^FS^XZ`,
    }
  }

  async voidLabel(input: {
    providerLabelId: string
    trackingNumber: string
    idempotencyKey: string
  }): Promise<CarrierVoidResult> {
    return {
      voided: true,
      providerReference: `mock-void-${stableToken(`${input.providerLabelId}:${input.idempotencyKey}`)}`,
      providerPayload: { mock: true, trackingNumber: input.trackingNumber },
    }
  }

  async track(input: { trackingNumber: string }): Promise<CarrierTrackingResult> {
    return {
      trackingNumber: input.trackingNumber,
      status: 'in_transit',
      estimatedDeliveryAt: null,
      deliveredAt: null,
      activities: [],
      providerPayload: { mock: true },
    }
  }

  async reconcileLabel(input: {
    orderGlobalId: string
    packageGlobalId: string
    carrier: string
    serviceCode: string
    idempotencyKey: string
  }): Promise<CarrierLabelReconciliationResult> {
    return {
      outcome: 'found',
      label: await this.createLabel(input),
      providerPayload: { mock: true },
    }
  }
}

export class MockPrintAdapter implements PrintAdapter {
  async print(input: {
    printerGlobalId: string
    labelGlobalId: string
    format: string
    payload: string
    idempotencyKey: string
  }): Promise<PrintResult> {
    return {
      accepted: true,
      providerJobId: `mock-print-${stableToken(`${input.printerGlobalId}:${input.labelGlobalId}:${input.idempotencyKey}`)}`,
      printedAt: new Date().toISOString(),
      error: null,
    }
  }
}
