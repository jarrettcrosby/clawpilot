import type {
  CarrierRate,
  ChargeBreakdown,
  CommerceOrderLineInput,
  EstimatedCharges,
  FulfillmentOptimizer,
  OptimizationRequest,
  OptimizationResult,
  PackagePlan,
  PricedCarrierRate,
  PricingDirective,
} from '@/lib/operations/types'

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function decimal(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function assertCurrency(value: string): string {
  const currency = String(value || '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('OPERATIONS_CURRENCY_INVALID')
  return currency
}

export function assertPositiveQuantity(value: unknown): number {
  const quantity = decimal(value)
  if (!(quantity > 0) || Math.round(quantity * 1_000_000) !== quantity * 1_000_000) {
    throw new Error('OPERATIONS_QUANTITY_INVALID')
  }
  return quantity
}

export function cartonizeSinglePackage(lines: CommerceOrderLineInput[]): PackagePlan[] {
  if (!lines.length) throw new Error('OPERATIONS_ORDER_LINES_REQUIRED')
  const aggregate = lines.reduce((result, line) => {
    const quantity = assertPositiveQuantity(line.quantity)
    result.weight += Math.max(0, integer(line.weightGrams)) * quantity
    result.length = Math.max(result.length, Math.max(1, integer(line.dimensionsMm.length, 100)))
    result.width = Math.max(result.width, Math.max(1, integer(line.dimensionsMm.width, 100)))
    result.height += Math.max(1, integer(line.dimensionsMm.height, 100)) * quantity
    result.ids.push(line.externalLineId)
    return result
  }, { weight: 0, length: 1, width: 1, height: 0, ids: [] as string[] })

  return [{
    packageNumber: 1,
    dimensionsMm: {
      length: aggregate.length,
      width: aggregate.width,
      height: Math.max(1, Math.ceil(aggregate.height)),
    },
    weightGrams: Math.ceil(aggregate.weight),
    lineExternalIds: aggregate.ids,
  }]
}

export function addCalendarDays(instant: string | Date, days: number): string {
  const date = instant instanceof Date ? new Date(instant) : new Date(instant)
  if (Number.isNaN(date.getTime())) throw new Error('OPERATIONS_DATE_INVALID')
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.floor(days)))
  return date.toISOString()
}

export function selectPromiseRate(rates: PricedCarrierRate[]): PricedCarrierRate {
  const eligible = rates
    .filter((rate) => rate.meetsPromise)
    .sort((left, right) => {
      if (left.internalCostMinor !== right.internalCostMinor) {
        return left.internalCostMinor < right.internalCostMinor ? -1 : 1
      }
      if (left.transitDays !== right.transitDays) return left.transitDays - right.transitDays
      return `${left.carrier}:${left.serviceCode}`.localeCompare(`${right.carrier}:${right.serviceCode}`)
    })
  if (!eligible[0]) throw new Error('OPERATIONS_PROMISE_UNAVAILABLE')
  return eligible[0]
}

function minor(value: unknown): bigint {
  const parsed = integer(value)
  if (parsed < 0) throw new Error('OPERATIONS_PRICE_INVALID')
  return BigInt(parsed)
}

function percentageAmount(baseMinor: bigint, basisPoints: number): bigint {
  if (basisPoints < 0) throw new Error('OPERATIONS_PRICE_INVALID')
  return (baseMinor * BigInt(basisPoints) + BigInt(5_000)) / BigInt(10_000)
}

export function priceContract(input: {
  directives: PricingDirective[]
  totalUnits: number
  freightCostMinor: bigint
  packageCount: number
}): EstimatedCharges {
  const charges: ChargeBreakdown[] = []
  const totalUnits = assertPositiveQuantity(input.totalUnits)
  for (const directive of [...input.directives].sort((a, b) => a.priority - b.priority || a.globalId.localeCompare(b.globalId))) {
    const config = directive.configuration
    let amountMinor = BigInt(0)
    let quantity = 1
    switch (directive.type) {
      case 'fixed_order_fee':
        amountMinor = minor(config.amountMinor)
        break
      case 'pick_fee':
        quantity = totalUnits
        amountMinor = minor(config.amountMinor) * BigInt(Math.ceil(totalUnits))
        break
      case 'tiered_pick_fee': {
        quantity = totalUnits
        const tiers = Array.isArray(config.tiers) ? config.tiers as Array<Record<string, unknown>> : []
        let remaining = Math.ceil(totalUnits)
        let previousThrough = 0
        for (const tier of tiers) {
          if (remaining <= 0) break
          const through = Math.max(previousThrough, integer(tier.throughUnits, Number.MAX_SAFE_INTEGER))
          const units = Math.min(remaining, through - previousThrough)
          amountMinor += BigInt(units) * minor(tier.amountMinor)
          remaining -= units
          previousThrough = through
        }
        if (remaining > 0) amountMinor += BigInt(remaining) * minor(config.overflowAmountMinor)
        break
      }
      case 'pack_fee':
        quantity = input.packageCount
        amountMinor = minor(config.amountMinor) * BigInt(input.packageCount)
        break
      case 'freight_markup_percent':
        amountMinor = percentageAmount(input.freightCostMinor, integer(config.basisPoints))
        break
      case 'storage_fee':
      case 'special_handling':
        amountMinor = minor(config.amountMinor)
        break
    }
    charges.push({
      directiveId: directive.id,
      directiveGlobalId: directive.globalId,
      type: directive.type,
      quantity,
      amountMinor,
    })
  }

  const freightMarkup = charges
    .filter((charge) => charge.type === 'freight_markup_percent')
    .reduce((sum, charge) => sum + charge.amountMinor, BigInt(0))
  const freightChargeMinor = input.freightCostMinor + freightMarkup
  const serviceRevenue = charges
    .filter((charge) => charge.type !== 'freight_markup_percent')
    .reduce((sum, charge) => sum + charge.amountMinor, BigInt(0))
  return {
    charges,
    freightChargeMinor,
    revenueMinor: serviceRevenue + freightChargeMinor,
  }
}

export function applyFreightPricing(rate: CarrierRate, directives: PricingDirective[]): PricedCarrierRate {
  const pricing = priceContract({
    directives: directives.filter((directive) => directive.type === 'freight_markup_percent'),
    totalUnits: 1,
    freightCostMinor: rate.internalCostMinor,
    packageCount: 1,
  })
  return { ...rate, customerChargeMinor: pricing.freightChargeMinor }
}

export class DeterministicFulfillmentOptimizer implements FulfillmentOptimizer {
  async plan(request: OptimizationRequest): Promise<OptimizationResult> {
    const complete = request.candidates
      .filter((candidate) => request.demand.every((demand) => (
        (candidate.availableByProductId.get(demand.productId) || 0) >= demand.quantity
      )))
      .sort((left, right) => {
        if (left.handlingCostMinor !== right.handlingCostMinor) {
          return left.handlingCostMinor < right.handlingCostMinor ? -1 : 1
        }
        return left.warehouseGlobalId.localeCompare(right.warehouseGlobalId)
      })

    if (complete[0]) {
      return {
        method: 'deterministic_fallback',
        solverStatus: 'fallback',
        warehouseIds: [complete[0].warehouseId],
        fallbackReason: 'OR-Tools is not enabled; selected the lowest-cost complete single-warehouse plan deterministically.',
        explanation: {
          completeCandidateCount: complete.length,
          selectedWarehouseGlobalId: complete[0].warehouseGlobalId,
          multiWarehouseConsidered: false,
        },
      }
    }

    return {
      method: 'deterministic_fallback',
      solverStatus: 'infeasible',
      warehouseIds: [],
      fallbackReason: request.allowMultiWarehouse
        ? 'No complete single-warehouse plan exists; multi-warehouse optimization is deferred to the OR-Tools phase.'
        : 'No complete single-warehouse plan exists and multi-warehouse fulfillment is not approved.',
      explanation: { completeCandidateCount: 0, multiWarehouseConsidered: request.allowMultiWarehouse },
    }
  }
}
