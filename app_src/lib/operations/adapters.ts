import { createHash } from 'node:crypto'
import { addCalendarDays } from '@/lib/operations/domain'
import type {
  Address,
  CarrierRate,
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
  rate(input: {
    origin: Address
    destination: Address
    packages: PackagePlan[]
    requestedDeliveryAt: string
    ratedAt: string
  }): Promise<CarrierRate[]>
  createLabel(input: {
    orderGlobalId: string
    packageGlobalId: string
    carrier: string
    serviceCode: string
    idempotencyKey: string
  }): Promise<LabelResult>
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
