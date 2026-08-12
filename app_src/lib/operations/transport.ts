import { createHash } from 'node:crypto'

export const TRANSPORT_PLAN_CONTRACT_VERSION = 'operations.transport_plan.v1' as const
export const MAX_TRANSPORT_PLAN_PACKAGES = 50
export const MAX_TRANSPORT_PLAN_PALLETS = 20

export const TRANSPORT_CAPABILITIES = [
  'small_parcel_rate',
  'small_parcel_tender',
  'small_parcel_void',
  'small_parcel_tracking',
  'small_parcel_documents',
  'small_parcel_pickup',
  'ltl_rate',
  'ltl_tender',
  'ltl_cancel',
  'ltl_bol',
  'ltl_documents',
  'ltl_pickup',
  'ltl_pickup_cancel',
  'ltl_tracking',
] as const

export type TransportCapability = typeof TRANSPORT_CAPABILITIES[number]
export type TransportProvider =
  | 'ups_rest'
  | 'fedex_rest'
  | 'wwex_speedship'
  | 'rl_carriers'
export type TransportMode = 'small_parcel' | 'ltl'
export type TransportHandlingUnitMode =
  | 'loose_packages'
  | 'palletized_handling_units'
export type TransportPackageForm = 'carton' | 'poly_bag'
export type PalletStackability = 'stackable' | 'non_stackable'
export type FreightClassificationEvidenceSource =
  | 'operator_attested'
  | 'product_profile'
  | 'density_calculation'
  | 'provider_returned'

export type TransportRequestProfile = Readonly<{
  hazardousMaterials: false
  declaredValue: null
  accessorials: readonly string[]
  pickupRequired: boolean
}>

export type TransportDimensionsMm = Readonly<{
  length: number
  width: number
  height: number
}>

export type TransportPackageReference =
  | Readonly<{
      referenceType: 'operations_package'
      packageGlobalId: string
      quotePackageKey: null
    }>
  | Readonly<{
      referenceType: 'quote_package'
      packageGlobalId: null
      quotePackageKey: string
    }>

export type ExecutingCarrierIdentity = Readonly<{
  code: string
  name: string
  scac: string | null
}>

export type TransportSelection = Readonly<{
  provider: TransportProvider
  transportMode: TransportMode
  handlingUnitMode: TransportHandlingUnitMode
  executingCarrier: ExecutingCarrierIdentity
}>

export type LoosePackagePlanPackage = Readonly<{
  packageSequence: number
  packageForm: TransportPackageForm
  packageReference: TransportPackageReference
  packageSnapshotHash: string
  dimensionsMm: TransportDimensionsMm
  grossWeightGrams: number
}>

export type LoosePackagePlan = Readonly<{
  contractVersion: typeof TRANSPORT_PLAN_CONTRACT_VERSION
  planVersion: number
  transportMode: 'small_parcel'
  handlingUnitMode: 'loose_packages'
  requestProfile: TransportRequestProfile
  packages: readonly LoosePackagePlanPackage[]
}>

export type FreightClassificationEvidence = Readonly<{
  freightClass: string
  nmfcCode: string | null
  source: FreightClassificationEvidenceSource
  reference: string
  description: string
  capturedAt: string
}>

export type LtlPalletMembership = Readonly<{
  membershipSequence: number
  packageSequence: number
  packageForm: 'carton'
  packageReference: TransportPackageReference
  packageSnapshotHash: string
  packageGrossWeightGrams: number
}>

export type LtlPalletCommodity = Readonly<{
  commoditySequence: number
  description: string
  pieces: number
  weightGrams: number
  classification: FreightClassificationEvidence
  membershipSequences: readonly number[]
}>

export type LtlPallet = Readonly<{
  palletKey: string
  palletSequence: number
  dimensionsMm: TransportDimensionsMm
  tareWeightGrams: number
  grossWeightGrams: number
  stackability: PalletStackability
  mixedCommodities: boolean
  memberships: readonly LtlPalletMembership[]
  commodities: readonly LtlPalletCommodity[]
}>

export type LtlPalletPlan = Readonly<{
  contractVersion: typeof TRANSPORT_PLAN_CONTRACT_VERSION
  planVersion: number
  transportMode: 'ltl'
  handlingUnitMode: 'palletized_handling_units'
  requestProfile: TransportRequestProfile
  pallets: readonly LtlPallet[]
}>

export type TransportHandlingPlan = LoosePackagePlan | LtlPalletPlan

const PACKAGE_GLOBAL_ID = /^gpa(?:[0-9]{7}|[0-9a-v]{12})$/
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const SHA256 = /^[a-f0-9]{64}$/
const CARRIER_CODE = /^[A-Z0-9][A-Z0-9._-]{1,31}$/
const SCAC = /^[A-Z]{2,4}$/
const NMFC = /^[0-9]{3,6}(?:-[0-9]{1,2})?$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MAX_DIMENSION_MM = 10_000
const MAX_WEIGHT_GRAMS = 100_000_000
const STANDARD_FREIGHT_CLASSES = new Set([
  '50',
  '55',
  '60',
  '65',
  '70',
  '77.5',
  '85',
  '92.5',
  '100',
  '110',
  '125',
  '150',
  '175',
  '200',
  '250',
  '300',
  '400',
  '500',
])

function fail(message: string): never {
  throw new Error(`TRANSPORT_PLAN_INVALID: ${message}`)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  const prototypeConstructor = prototype?.constructor
  if (
    prototype !== null
    && (
      typeof prototypeConstructor !== 'function'
      || Function.prototype.toString.call(prototypeConstructor)
        !== Function.prototype.toString.call(Object)
    )
  ) {
    fail(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unsupported) fail(`${label}.${unsupported} is not supported`)
  const missing = allowed.find((key) => !Object.hasOwn(value, key))
  if (missing) fail(`${label}.${missing} is required`)
}

function text(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== 'string') fail(`${label} must be text`)
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || CONTROL_CHARACTER.test(normalized)
  ) {
    fail(`${label} must be ${minimum}-${maximum} printable characters`)
  }
  return normalized
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`)
  return value
}

function array(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}-${maximum} items`)
  }
  return value
}

function literal<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function normalizeContractVersion(value: unknown) {
  if (value !== TRANSPORT_PLAN_CONTRACT_VERSION) {
    fail(`contractVersion must be ${TRANSPORT_PLAN_CONTRACT_VERSION}`)
  }
  return TRANSPORT_PLAN_CONTRACT_VERSION
}

function normalizeDimensions(value: unknown, label: string): TransportDimensionsMm {
  const input = record(value, label)
  exactKeys(input, label, ['length', 'width', 'height'])
  return deepFreeze({
    length: integer(input.length, `${label}.length`, 1, MAX_DIMENSION_MM),
    width: integer(input.width, `${label}.width`, 1, MAX_DIMENSION_MM),
    height: integer(input.height, `${label}.height`, 1, MAX_DIMENSION_MM),
  })
}

function normalizePackageReference(
  value: unknown,
  label: string,
): TransportPackageReference {
  const input = record(value, label)
  exactKeys(input, label, ['referenceType', 'packageGlobalId', 'quotePackageKey'])
  if (input.referenceType === 'operations_package') {
    if (typeof input.packageGlobalId !== 'string' || !PACKAGE_GLOBAL_ID.test(input.packageGlobalId)) {
      fail(`${label}.packageGlobalId must be an operations package Global ID`)
    }
    if (input.quotePackageKey !== null) {
      fail(`${label}.quotePackageKey must be null for a persisted package`)
    }
    return deepFreeze({
      referenceType: 'operations_package',
      packageGlobalId: input.packageGlobalId,
      quotePackageKey: null,
    })
  }
  if (input.referenceType === 'quote_package') {
    if (input.packageGlobalId !== null) {
      fail(`${label}.packageGlobalId must be null for a quote package`)
    }
    const quotePackageKey = text(input.quotePackageKey, `${label}.quotePackageKey`, 1, 120)
    if (!SAFE_KEY.test(quotePackageKey)) {
      fail(`${label}.quotePackageKey contains unsupported characters`)
    }
    return deepFreeze({
      referenceType: 'quote_package',
      packageGlobalId: null,
      quotePackageKey,
    })
  }
  fail(`${label}.referenceType must be operations_package or quote_package`)
}

function normalizeSnapshotHash(value: unknown, label: string) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`)
  }
  return value
}

function normalizeTransportRequestProfile(
  value: unknown,
): TransportRequestProfile {
  const input = record(value, 'plan.requestProfile')
  exactKeys(input, 'plan.requestProfile', [
    'hazardousMaterials',
    'declaredValue',
    'accessorials',
    'pickupRequired',
  ])
  if (input.hazardousMaterials !== false) {
    fail('plan.requestProfile.hazardousMaterials must be false in contract v1')
  }
  if (input.declaredValue !== null) {
    fail('plan.requestProfile.declaredValue must be null in contract v1')
  }
  const accessorials = array(
    input.accessorials,
    'plan.requestProfile.accessorials',
    0,
    20,
  ).map((value, index) => {
    const accessorial = text(
      value,
      `plan.requestProfile.accessorials[${index}]`,
      2,
      32,
    ).toUpperCase()
    if (!CARRIER_CODE.test(accessorial)) {
      fail(`plan.requestProfile.accessorials[${index}] is invalid`)
    }
    return accessorial
  }).sort()
  assertUnique(accessorials, 'plan.requestProfile.accessorials')
  return deepFreeze({
    hazardousMaterials: false,
    declaredValue: null,
    accessorials,
    pickupRequired: boolean(
      input.pickupRequired,
      'plan.requestProfile.pickupRequired',
    ),
  })
}

function packageIdentity(reference: TransportPackageReference) {
  return reference.referenceType === 'operations_package'
    ? `operations_package:${reference.packageGlobalId}`
    : `quote_package:${reference.quotePackageKey}`
}

function assertContiguous(values: readonly number[], label: string) {
  const sorted = [...values].sort((left, right) => left - right)
  for (const [index, value] of sorted.entries()) {
    if (value !== index + 1) fail(`${label} must be contiguous starting at 1`)
  }
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('hash input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`
  }
  fail('hash input contains an unsupported value')
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

export function normalizeTransportProvider(value: unknown): TransportProvider {
  if (typeof value !== 'string') fail('provider must be text')
  return literal(value.trim().toLowerCase(), 'provider', [
    'ups_rest',
    'fedex_rest',
    'wwex_speedship',
    'rl_carriers',
  ] as const)
}

export function normalizeTransportCapability(value: unknown): TransportCapability {
  return literal(value, 'capability', TRANSPORT_CAPABILITIES)
}

export function normalizeExecutingCarrierIdentity(
  value: unknown,
  options: Readonly<{ provider: TransportProvider; transportMode: TransportMode }>,
): ExecutingCarrierIdentity {
  const input = record(value, 'executingCarrier')
  exactKeys(input, 'executingCarrier', ['code', 'name', 'scac'])
  const code = text(input.code, 'executingCarrier.code', 2, 32).toUpperCase()
  if (!CARRIER_CODE.test(code)) fail('executingCarrier.code is invalid')
  const name = text(input.name, 'executingCarrier.name', 1, 120)
  const scac = input.scac === null
    ? null
    : text(input.scac, 'executingCarrier.scac', 2, 4).toUpperCase()
  if (scac !== null && !SCAC.test(scac)) {
    fail('executingCarrier.scac must be a 2-4 letter SCAC')
  }
  if (
    options.transportMode === 'ltl'
    && options.provider !== 'rl_carriers'
    && scac === null
  ) {
    fail('executingCarrier.scac is required for broker-returned LTL carriers')
  }
  if (options.provider === 'ups_rest' && code !== 'UPS') {
    fail('UPS REST must retain UPS as the executing carrier')
  }
  if (options.provider === 'fedex_rest' && code !== 'FEDEX') {
    fail('FedEx REST must retain FEDEX as the executing carrier')
  }
  if (
    options.provider === 'wwex_speedship'
    && options.transportMode === 'small_parcel'
    && code !== 'UPS'
  ) {
    fail('WWEX small parcel must retain UPS as the executing carrier')
  }
  return deepFreeze({ code, name, scac })
}

export function mapWwexExecutingCarrierIdentity(
  value: unknown,
  transportModeValue: unknown,
): ExecutingCarrierIdentity {
  const vendor = record(value, 'wwexVendor')
  exactKeys(vendor, 'wwexVendor', ['vendorId', 'name', 'scac'])
  const transportMode = literal(transportModeValue, 'transportMode', [
    'small_parcel',
    'ltl',
  ] as const)
  return normalizeExecutingCarrierIdentity({
    code: vendor.vendorId,
    name: vendor.name,
    scac: vendor.scac,
  }, {
    provider: 'wwex_speedship',
    transportMode,
  })
}

export function mapRlCarriersExecutingCarrierIdentity(): ExecutingCarrierIdentity {
  return normalizeExecutingCarrierIdentity({
    code: 'RL_CARRIERS',
    name: 'R+L Carriers',
    scac: null,
  }, {
    provider: 'rl_carriers',
    transportMode: 'ltl',
  })
}

export function normalizeTransportSelection(value: unknown): TransportSelection {
  const input = record(value, 'selection')
  exactKeys(input, 'selection', [
    'provider',
    'transportMode',
    'handlingUnitMode',
    'executingCarrier',
  ])
  const provider = normalizeTransportProvider(input.provider)
  const transportMode = literal(input.transportMode, 'transportMode', [
    'small_parcel',
    'ltl',
  ] as const)
  const handlingUnitMode = literal(input.handlingUnitMode, 'handlingUnitMode', [
    'loose_packages',
    'palletized_handling_units',
  ] as const)
  if (
    (transportMode === 'small_parcel' && handlingUnitMode !== 'loose_packages')
    || (transportMode === 'ltl' && handlingUnitMode !== 'palletized_handling_units')
  ) {
    fail('transportMode and handlingUnitMode do not describe the same physical plan')
  }
  if ((provider === 'ups_rest' || provider === 'fedex_rest') && transportMode !== 'small_parcel') {
    fail(`${provider} is small-parcel only in this transport contract`)
  }
  if (provider === 'rl_carriers' && transportMode !== 'ltl') {
    fail('rl_carriers is LTL only')
  }
  const executingCarrier = normalizeExecutingCarrierIdentity(input.executingCarrier, {
    provider,
    transportMode,
  })
  return deepFreeze({ provider, transportMode, handlingUnitMode, executingCarrier })
}

export function normalizeLoosePackagePlan(value: unknown): LoosePackagePlan {
  const input = record(value, 'plan')
  exactKeys(input, 'plan', [
    'contractVersion',
    'planVersion',
    'transportMode',
    'handlingUnitMode',
    'requestProfile',
    'packages',
  ])
  const contractVersion = normalizeContractVersion(input.contractVersion)
  const planVersion = integer(input.planVersion, 'plan.planVersion', 1, 2_147_483_647)
  const requestProfile = normalizeTransportRequestProfile(input.requestProfile)
  if (input.transportMode !== 'small_parcel' || input.handlingUnitMode !== 'loose_packages') {
    fail('a loose package plan must use small_parcel and loose_packages')
  }
  const packages = array(
    input.packages,
    'plan.packages',
    1,
    MAX_TRANSPORT_PLAN_PACKAGES,
  ).map((value, index): LoosePackagePlanPackage => {
    const label = `plan.packages[${index}]`
    const item = record(value, label)
    exactKeys(item, label, [
      'packageSequence',
      'packageForm',
      'packageReference',
      'packageSnapshotHash',
      'dimensionsMm',
      'grossWeightGrams',
    ])
    return deepFreeze({
      packageSequence: integer(
        item.packageSequence,
        `${label}.packageSequence`,
        1,
        MAX_TRANSPORT_PLAN_PACKAGES,
      ),
      packageForm: literal(item.packageForm, `${label}.packageForm`, [
        'carton',
        'poly_bag',
      ] as const),
      packageReference: normalizePackageReference(
        item.packageReference,
        `${label}.packageReference`,
      ),
      packageSnapshotHash: normalizeSnapshotHash(
        item.packageSnapshotHash,
        `${label}.packageSnapshotHash`,
      ),
      dimensionsMm: normalizeDimensions(item.dimensionsMm, `${label}.dimensionsMm`),
      grossWeightGrams: integer(
        item.grossWeightGrams,
        `${label}.grossWeightGrams`,
        1,
        MAX_WEIGHT_GRAMS,
      ),
    })
  }).sort((left, right) => left.packageSequence - right.packageSequence)
  assertContiguous(packages.map(({ packageSequence }) => packageSequence), 'packageSequence')
  assertUnique(packages.map(({ packageReference }) => packageIdentity(packageReference)), 'packages')
  return deepFreeze({
    contractVersion,
    planVersion,
    transportMode: 'small_parcel',
    handlingUnitMode: 'loose_packages',
    requestProfile,
    packages,
  })
}

function normalizeClassification(value: unknown, label: string): FreightClassificationEvidence {
  const input = record(value, label)
  exactKeys(input, label, [
    'freightClass',
    'nmfcCode',
    'source',
    'reference',
    'description',
    'capturedAt',
  ])
  const rawClass = typeof input.freightClass === 'number'
    ? String(input.freightClass)
    : text(input.freightClass, `${label}.freightClass`, 2, 5)
  if (!STANDARD_FREIGHT_CLASSES.has(rawClass)) {
    fail(`${label}.freightClass is not a standard freight class`)
  }
  const nmfcCode = input.nmfcCode === null
    ? null
    : text(input.nmfcCode, `${label}.nmfcCode`, 3, 9).toUpperCase()
  if (nmfcCode !== null && !NMFC.test(nmfcCode)) {
    fail(`${label}.nmfcCode is invalid`)
  }
  const source = literal(input.source, `${label}.source`, [
    'operator_attested',
    'product_profile',
    'density_calculation',
    'provider_returned',
  ] as const)
  const reference = text(input.reference, `${label}.reference`, 1, 200)
  const description = text(input.description, `${label}.description`, 3, 500)
  const capturedAt = text(input.capturedAt, `${label}.capturedAt`, 24, 24)
  if (!ISO_INSTANT.test(capturedAt) || new Date(capturedAt).toISOString() !== capturedAt) {
    fail(`${label}.capturedAt must be a canonical UTC instant`)
  }
  return deepFreeze({
    freightClass: rawClass,
    nmfcCode,
    source,
    reference,
    description,
    capturedAt,
  })
}

export function normalizeLtlPalletPlan(value: unknown): LtlPalletPlan {
  const input = record(value, 'plan')
  exactKeys(input, 'plan', [
    'contractVersion',
    'planVersion',
    'transportMode',
    'handlingUnitMode',
    'requestProfile',
    'pallets',
  ])
  const contractVersion = normalizeContractVersion(input.contractVersion)
  const planVersion = integer(input.planVersion, 'plan.planVersion', 1, 2_147_483_647)
  const requestProfile = normalizeTransportRequestProfile(input.requestProfile)
  if (input.transportMode !== 'ltl' || input.handlingUnitMode !== 'palletized_handling_units') {
    fail('an LTL pallet plan must use ltl and palletized_handling_units')
  }
  const packageIdentities: string[] = []
  const packageSequences: number[] = []
  let packageCount = 0
  const pallets = array(
    input.pallets,
    'plan.pallets',
    1,
    MAX_TRANSPORT_PLAN_PALLETS,
  ).map((value, palletIndex): LtlPallet => {
    const label = `plan.pallets[${palletIndex}]`
    const item = record(value, label)
    exactKeys(item, label, [
      'palletKey',
      'palletSequence',
      'dimensionsMm',
      'tareWeightGrams',
      'grossWeightGrams',
      'stackability',
      'mixedCommodities',
      'memberships',
      'commodities',
    ])
    const palletKey = text(item.palletKey, `${label}.palletKey`, 1, 120)
    if (!SAFE_KEY.test(palletKey)) fail(`${label}.palletKey contains unsupported characters`)
    const memberships = array(
      item.memberships,
      `${label}.memberships`,
      1,
      MAX_TRANSPORT_PLAN_PACKAGES,
    ).map((value, membershipIndex): LtlPalletMembership => {
      packageCount += 1
      const membershipLabel = `${label}.memberships[${membershipIndex}]`
      const membership = record(value, membershipLabel)
      exactKeys(membership, membershipLabel, [
        'membershipSequence',
        'packageSequence',
        'packageForm',
        'packageReference',
        'packageSnapshotHash',
        'packageGrossWeightGrams',
      ])
      const packageReference = normalizePackageReference(
        membership.packageReference,
        `${membershipLabel}.packageReference`,
      )
      const packageSequence = integer(
        membership.packageSequence,
        `${membershipLabel}.packageSequence`,
        1,
        MAX_TRANSPORT_PLAN_PACKAGES,
      )
      packageIdentities.push(packageIdentity(packageReference))
      packageSequences.push(packageSequence)
      return deepFreeze({
        membershipSequence: integer(
          membership.membershipSequence,
          `${membershipLabel}.membershipSequence`,
          1,
          MAX_TRANSPORT_PLAN_PACKAGES,
        ),
        packageSequence,
        packageForm: literal(
          membership.packageForm,
          `${membershipLabel}.packageForm`,
          ['carton'] as const,
        ),
        packageReference,
        packageSnapshotHash: normalizeSnapshotHash(
          membership.packageSnapshotHash,
          `${membershipLabel}.packageSnapshotHash`,
        ),
        packageGrossWeightGrams: integer(
          membership.packageGrossWeightGrams,
          `${membershipLabel}.packageGrossWeightGrams`,
          1,
          MAX_WEIGHT_GRAMS,
        ),
      })
    }).sort((left, right) => left.membershipSequence - right.membershipSequence)
    assertContiguous(
      memberships.map(({ membershipSequence }) => membershipSequence),
      `${label}.membershipSequence`,
    )
    const membershipSequenceSet = new Set(
      memberships.map(({ membershipSequence }) => membershipSequence),
    )
    const referencedMembershipSequences: number[] = []
    const commodities = array(
      item.commodities,
      `${label}.commodities`,
      1,
      MAX_TRANSPORT_PLAN_PACKAGES,
    ).map((value, commodityIndex): LtlPalletCommodity => {
      const commodityLabel = `${label}.commodities[${commodityIndex}]`
      const commodity = record(value, commodityLabel)
      exactKeys(commodity, commodityLabel, [
        'commoditySequence',
        'description',
        'pieces',
        'weightGrams',
        'classification',
        'membershipSequences',
      ])
      const membershipSequences = array(
        commodity.membershipSequences,
        `${commodityLabel}.membershipSequences`,
        1,
        MAX_TRANSPORT_PLAN_PACKAGES,
      ).map((sequence, sequenceIndex) => integer(
        sequence,
        `${commodityLabel}.membershipSequences[${sequenceIndex}]`,
        1,
        MAX_TRANSPORT_PLAN_PACKAGES,
      )).sort((left, right) => left - right)
      assertUnique(
        membershipSequences.map(String),
        `${commodityLabel}.membershipSequences`,
      )
      if (membershipSequences.some((sequence) => !membershipSequenceSet.has(sequence))) {
        fail(`${commodityLabel}.membershipSequences must reference memberships on this pallet`)
      }
      const pieces = integer(
        commodity.pieces,
        `${commodityLabel}.pieces`,
        1,
        1_000_000,
      )
      if (pieces !== membershipSequences.length) {
        fail(`${commodityLabel}.pieces must equal its classified package memberships`)
      }
      referencedMembershipSequences.push(...membershipSequences)
      return deepFreeze({
        commoditySequence: integer(
          commodity.commoditySequence,
          `${commodityLabel}.commoditySequence`,
          1,
          MAX_TRANSPORT_PLAN_PACKAGES,
        ),
        description: text(
          commodity.description,
          `${commodityLabel}.description`,
          1,
          255,
        ),
        pieces,
        weightGrams: integer(
          commodity.weightGrams,
          `${commodityLabel}.weightGrams`,
          1,
          MAX_WEIGHT_GRAMS,
        ),
        classification: normalizeClassification(
          commodity.classification,
          `${commodityLabel}.classification`,
        ),
        membershipSequences,
      })
    }).sort((left, right) => left.commoditySequence - right.commoditySequence)
    assertContiguous(
      commodities.map(({ commoditySequence }) => commoditySequence),
      `${label}.commoditySequence`,
    )
    const uniqueReferencedMembershipSequences = new Set(
      referencedMembershipSequences,
    )
    if (
      referencedMembershipSequences.length
        !== uniqueReferencedMembershipSequences.size
      || membershipSequenceSet.size
        !== uniqueReferencedMembershipSequences.size
    ) {
      fail(`${label}.commodities must classify every pallet membership exactly once`)
    }
    const mixedCommodities = boolean(
      item.mixedCommodities,
      `${label}.mixedCommodities`,
    )
    if (mixedCommodities !== (commodities.length > 1)) {
      fail(`${label}.mixedCommodities must match the commodity count`)
    }
    const memberGrossWeight = memberships.reduce(
      (sum, membership) => sum + membership.packageGrossWeightGrams,
      0,
    )
    const commodityWeight = commodities.reduce(
      (sum, commodity) => sum + commodity.weightGrams,
      0,
    )
    if (commodityWeight !== memberGrossWeight) {
      fail(`${label}.commodity weights must equal member package gross weight`)
    }
    const tareWeightGrams = integer(
      item.tareWeightGrams,
      `${label}.tareWeightGrams`,
      1,
      MAX_WEIGHT_GRAMS,
    )
    const grossWeightGrams = integer(
      item.grossWeightGrams,
      `${label}.grossWeightGrams`,
      1,
      MAX_WEIGHT_GRAMS,
    )
    const minimumGrossWeight = tareWeightGrams + memberGrossWeight
    if (grossWeightGrams !== minimumGrossWeight) {
      fail(`${label}.grossWeightGrams must equal pallet tare plus member packages`)
    }
    return deepFreeze({
      palletKey,
      palletSequence: integer(
        item.palletSequence,
        `${label}.palletSequence`,
        1,
        MAX_TRANSPORT_PLAN_PALLETS,
      ),
      dimensionsMm: normalizeDimensions(item.dimensionsMm, `${label}.dimensionsMm`),
      tareWeightGrams,
      grossWeightGrams,
      stackability: literal(item.stackability, `${label}.stackability`, [
        'stackable',
        'non_stackable',
      ] as const),
      mixedCommodities,
      memberships,
      commodities,
    })
  }).sort((left, right) => left.palletSequence - right.palletSequence)
  if (packageCount > MAX_TRANSPORT_PLAN_PACKAGES) {
    fail(`an LTL plan may contain at most ${MAX_TRANSPORT_PLAN_PACKAGES} packages`)
  }
  assertContiguous(pallets.map(({ palletSequence }) => palletSequence), 'palletSequence')
  assertUnique(pallets.map(({ palletKey }) => palletKey), 'pallet keys')
  assertUnique(packageIdentities, 'pallet memberships')
  assertUnique(packageSequences.map(String), 'packageSequence')
  assertContiguous(packageSequences, 'packageSequence')
  return deepFreeze({
    contractVersion,
    planVersion,
    transportMode: 'ltl',
    handlingUnitMode: 'palletized_handling_units',
    requestProfile,
    pallets,
  })
}

export function normalizeTransportHandlingPlan(value: unknown): TransportHandlingPlan {
  const input = record(value, 'plan')
  if (input.transportMode === 'small_parcel') return normalizeLoosePackagePlan(input)
  if (input.transportMode === 'ltl') return normalizeLtlPalletPlan(input)
  fail('plan.transportMode must be small_parcel or ltl')
}

export function transportHandlingPlanHash(value: unknown) {
  const normalized = normalizeTransportHandlingPlan(value)
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
}

export function loosePackagePlanHash(value: unknown) {
  const normalized = normalizeLoosePackagePlan(value)
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
}

export function ltlPalletPlanHash(value: unknown) {
  const normalized = normalizeLtlPalletPlan(value)
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
}

export function transportRequestProfileHash(value: unknown) {
  const normalized = normalizeTransportRequestProfile(value)
  return createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')
}
