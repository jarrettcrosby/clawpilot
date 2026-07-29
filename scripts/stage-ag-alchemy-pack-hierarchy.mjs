#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

export const SCRIPT_VERSION = 'ag-alchemy-pack-hierarchy-v4'
export const TRUSTED_RAILWAY_PROJECT_ID =
  'b5169ebd-8166-4b96-9a81-7cc8adaa9270'
export const TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID =
  'e4abd95f-825c-4242-b37b-825a92597e98'
export const TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT =
  '750aa268-0e31-4065-a99c-4016e4d4fab1'
export const TARGET_ORGANIZATION_NAME = 'AG Alchemy, LLC'
export const CUSTOMER_EVIDENCE_REFERENCE =
  'Customer packaging specification received 2026-07-28'
const STARTER_EVIDENCE_REFERENCE =
  'ClawPilot starter assortment nominal specification'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PRODUCT_GLOBAL_ID_PATTERN = /^gp\d{7}$/
const PROFILE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/
const COMPATIBILITY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/
const MAX_ASSIGNED_PRODUCTS = 250
export const LOOSE_SIX_OUNCE_COMPATIBILITY_KEY =
  'ag-alchemy.loose-six-ounce-bags.v1'

function fail(message) {
  throw new Error(message)
}

function environmentValue(name) {
  return String(process.env[name] || '').trim()
}

export function assertTrustedDevelopmentEnvironment(environment) {
  if (
    String(environment?.RAILWAY_PROJECT_ID || '').trim()
      !== TRUSTED_RAILWAY_PROJECT_ID
    || String(environment?.RAILWAY_ENVIRONMENT_ID || '').trim()
      !== TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID
    || String(environment?.RAILWAY_ENVIRONMENT_NAME || '').trim()
      !== 'development'
  ) {
    fail('This command is restricted to the trusted ClawPilot development environment')
  }
  return true
}

function requireTrustedDevelopmentEnvironment() {
  return assertTrustedDevelopmentEnvironment(process.env)
}

export function assertTrustedDatabaseIdentity(identity) {
  if (
    !UUID_PATTERN.test(identity?.database_fingerprint || '')
    || identity.database_fingerprint
      !== TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT
  ) {
    fail('Connected database is not the trusted ClawPilot development database')
  }
  return true
}

export function assertFreshPlanFingerprint(expected, current) {
  if (
    !expected
    || !/^[a-f0-9]{64}$/.test(expected)
    || expected !== current
  ) {
    fail('Apply requires the exact current plan fingerprint from a fresh plan')
  }
  return true
}

export function assertExplicitActor(actorEmail) {
  const normalized = String(actorEmail || '').trim().toLowerCase()
  if (!normalized) {
    fail('Plan and apply require an explicit active AG Alchemy actor')
  }
  return normalized
}

function inches(value) {
  return Math.round(value * 25.4)
}

function dimensions(length, width, height) {
  return Object.freeze({
    lengthMm: inches(length),
    widthMm: inches(width),
    heightMm: height === null ? null : inches(height),
  })
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex')
}

export const AG_PACKAGING_MATERIAL_DRAFTS = Object.freeze([
  Object.freeze({
    code: 'AG12V2',
    name: 'AG12V2 shipping carton',
    materialType: 'carton',
    ...dimensions(11, 9, 7),
    dimensionBasis: 'unspecified',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    tareWeightGrams: null,
    maxWeightGrams: null,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'customer_supplied',
  }),
  Object.freeze({
    code: 'AG-20LB-BOX',
    name: '20 lb bulk shipping carton',
    materialType: 'carton',
    ...dimensions(17, 11, 7),
    dimensionBasis: 'unspecified',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    tareWeightGrams: null,
    maxWeightGrams: null,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'customer_supplied',
  }),
  Object.freeze({
    code: 'AG-2OZ-CARTON-BOX',
    name: '2 oz display-carton shipping box',
    materialType: 'carton',
    ...dimensions(14, 11, 8),
    dimensionBasis: 'unspecified',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    tareWeightGrams: null,
    maxWeightGrams: null,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'customer_supplied',
  }),
  Object.freeze({
    code: 'AG-ENVELOPE-09X12',
    name: '9 x 12 shipping envelope',
    materialType: 'poly_mailer',
    ...dimensions(12, 9, null),
    dimensionBasis: 'unspecified',
    dimensionEvidenceType: 'customer_confirmed',
    dimensionEvidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    tareWeightGrams: null,
    maxWeightGrams: null,
    unitCostMinor: null,
    currency: null,
    status: 'draft',
    source: 'customer_supplied',
  }),
])

export const AG_SYNTHETIC_STARTER_MATERIALS = Object.freeze([
  Object.freeze({
    code: 'STARTER-BOX-06X06X04',
    name: 'Compact starter carton',
    materialType: 'carton',
    lengthMm: 152,
    widthMm: 152,
    heightMm: 102,
    tareWeightGrams: 95,
    maxWeightGrams: 4536,
  }),
  Object.freeze({
    code: 'STARTER-BOX-08X06X04',
    name: 'Small starter carton',
    materialType: 'carton',
    lengthMm: 203,
    widthMm: 152,
    heightMm: 102,
    tareWeightGrams: 120,
    maxWeightGrams: 6804,
  }),
  Object.freeze({
    code: 'STARTER-BOX-10X08X06',
    name: 'Medium starter carton',
    materialType: 'carton',
    lengthMm: 254,
    widthMm: 203,
    heightMm: 152,
    tareWeightGrams: 190,
    maxWeightGrams: 11340,
  }),
  Object.freeze({
    code: 'STARTER-BOX-12X10X08',
    name: 'Large starter carton',
    materialType: 'carton',
    lengthMm: 305,
    widthMm: 254,
    heightMm: 203,
    tareWeightGrams: 285,
    maxWeightGrams: 15876,
  }),
  Object.freeze({
    code: 'STARTER-POLY-10X13',
    name: 'Starter poly mailer',
    materialType: 'poly_mailer',
    lengthMm: 330,
    widthMm: 254,
    heightMm: 51,
    tareWeightGrams: 18,
    maxWeightGrams: 2268,
  }),
  Object.freeze({
    code: 'STARTER-PADDED-08X12',
    name: 'Starter padded mailer',
    materialType: 'padded_mailer',
    lengthMm: 305,
    widthMm: 216,
    heightMm: 38,
    tareWeightGrams: 32,
    maxWeightGrams: 1814,
  }),
])

const materialDimensions = new Map(
  AG_PACKAGING_MATERIAL_DRAFTS.map((material) => [material.code, {
    lengthMm: material.lengthMm,
    widthMm: material.widthMm,
    heightMm: material.heightMm,
  }]),
)

function profile(input) {
  return Object.freeze({
    isDefault: false,
    dimensionBasis: 'unspecified',
    grossWeightGrams: null,
    weightBasis: 'unspecified',
    fitModel: 'rigid_3d',
    shipsAsOwnPackage: false,
    assemblyPolicy: 'never',
    evidenceType: 'customer_confirmed',
    evidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    source: 'customer_supplied',
    ...input,
  })
}

function relationship(parentProfileKey, childProfileKey, containedQuantity) {
  return Object.freeze({
    parentProfileKey,
    childProfileKey,
    containedQuantity,
    evidenceType: 'customer_confirmed',
    evidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    source: 'customer_supplied',
  })
}

function recipe(input) {
  return Object.freeze({
    outputQuantity: 1,
    packagingMaterialQuantity: 1,
    fulfillmentPolicy: 'prefer_full_case',
    remainderPolicy: 'case_plus_each',
    inventoryEvidenceRequirement: 'either',
    assemblyPolicy: 'allowed',
    exclusiveContents: true,
    minimumInputQuantity: null,
    contentCompatibilityKey: null,
    allowsMixedProducts: false,
    fitEvidenceType: 'customer_confirmed',
    fitEvidenceReference: CUSTOMER_EVIDENCE_REFERENCE,
    source: 'customer_supplied',
    ...input,
  })
}

const AG12V2_DIMENSIONS = materialDimensions.get('AG12V2')
const TWENTY_POUND_BOX_DIMENSIONS = materialDimensions.get('AG-20LB-BOX')
const DISPLAY_CARTON_BOX_DIMENSIONS =
  materialDimensions.get('AG-2OZ-CARTON-BOX')

export const AG_PRODUCT_PACK_CLASSES = Object.freeze({
  six_ounce_bag: Object.freeze({
    label: '6 oz bag',
    providerSellUnitProfileKey: 'customer-each',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-each',
        profileName: '6 oz bag each',
        packageLevel: 'each',
        baseEachQuantity: 1,
        isDefault: true,
        ...dimensions(8, 6, 2),
        dimensionBasis: 'outer',
        fitModel: 'approved_recipe_only',
      }),
      profile({
        profileKey: 'customer-loose-carton-18',
        profileName: 'Loose shipping carton for up to 18 6 oz bags',
        packageLevel: 'case',
        baseEachQuantity: 18,
        ...AG12V2_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'allow_from_child',
      }),
      profile({
        profileKey: 'customer-loose-carton-30',
        profileName: 'Loose shipping carton for up to 30 6 oz bags',
        packageLevel: 'case',
        baseEachQuantity: 30,
        ...TWENTY_POUND_BOX_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'allow_from_child',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-loose-carton-18', 'customer-each', 18),
      relationship('customer-loose-carton-30', 'customer-each', 30),
    ]),
    recipes: Object.freeze([
      recipe({
        recipeKey: 'customer-loose-capacity-18',
        recipeName: 'Pack up to 18 loose 6 oz bags in AG12V2',
        inputProfileKey: 'customer-each',
        outputProfileKey: 'customer-loose-carton-18',
        packagingMaterialCode: 'AG12V2',
        inputQuantity: 18,
        minimumInputQuantity: 12,
        recipeType: 'max_capacity',
        contentCompatibilityKey: LOOSE_SIX_OUNCE_COMPATIBILITY_KEY,
        allowsMixedProducts: true,
        exclusiveContents: false,
      }),
      recipe({
        recipeKey: 'customer-loose-capacity-30',
        recipeName: 'Pack up to 30 loose 6 oz bags in 20 lb box',
        inputProfileKey: 'customer-each',
        outputProfileKey: 'customer-loose-carton-30',
        packagingMaterialCode: 'AG-20LB-BOX',
        inputQuantity: 30,
        minimumInputQuantity: null,
        recipeType: 'max_capacity',
        contentCompatibilityKey: LOOSE_SIX_OUNCE_COMPATIBILITY_KEY,
        allowsMixedProducts: true,
        exclusiveContents: false,
      }),
    ]),
  }),
  six_ounce_case_12: Object.freeze({
    label: 'Prepackaged case of 12 6 oz bags',
    providerSellUnitProfileKey: 'customer-case-12',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-bag-each',
        profileName: 'Contained 6 oz bag',
        packageLevel: 'each',
        baseEachQuantity: 1,
        ...dimensions(8, 6, 2),
        dimensionBasis: 'outer',
      }),
      profile({
        profileKey: 'customer-case-12',
        profileName: 'Prepackaged case of 12 6 oz bags',
        packageLevel: 'case',
        baseEachQuantity: 12,
        isDefault: true,
        ...AG12V2_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'never',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-case-12', 'customer-bag-each', 12),
    ]),
    recipes: Object.freeze([]),
  }),
  two_ounce_bag: Object.freeze({
    label: '2 oz bag',
    providerSellUnitProfileKey: 'customer-each',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-each',
        profileName: '2 oz bag each',
        packageLevel: 'each',
        baseEachQuantity: 1,
        isDefault: true,
        ...dimensions(5.5, 4.5, 1),
        dimensionBasis: 'outer',
      }),
      profile({
        profileKey: 'customer-case-36',
        profileName: 'Prepackaged case of 36 2 oz bags',
        packageLevel: 'case',
        baseEachQuantity: 36,
        ...AG12V2_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'never',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-case-36', 'customer-each', 36),
    ]),
    recipes: Object.freeze([]),
  }),
  two_ounce_display_carton: Object.freeze({
    label: 'Prepackaged display carton of 6 2 oz bags',
    providerSellUnitProfileKey: 'customer-display-carton-6',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-bag-each',
        profileName: 'Contained 2 oz bag',
        packageLevel: 'each',
        baseEachQuantity: 1,
        ...dimensions(5.5, 4.5, 1),
        dimensionBasis: 'outer',
      }),
      profile({
        profileKey: 'customer-display-carton-6',
        profileName: 'Prepackaged display carton of 6 2 oz bags',
        packageLevel: 'inner_pack',
        baseEachQuantity: 6,
        isDefault: true,
        ...dimensions(7.5, 4.5, 5.5),
        dimensionBasis: 'outer',
        assemblyPolicy: 'never',
      }),
      profile({
        profileKey: 'customer-six-display-cartons',
        profileName: 'Shipping box for up to 6 display cartons',
        packageLevel: 'case',
        baseEachQuantity: 36,
        ...DISPLAY_CARTON_BOX_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'allow_from_child',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-display-carton-6', 'customer-bag-each', 6),
      relationship(
        'customer-six-display-cartons',
        'customer-display-carton-6',
        6,
      ),
    ]),
    recipes: Object.freeze([
      recipe({
        recipeKey: 'customer-six-display-cartons',
        recipeName: 'Pack 6 display cartons in 2 oz carton box',
        inputProfileKey: 'customer-display-carton-6',
        outputProfileKey: 'customer-six-display-cartons',
        packagingMaterialCode: 'AG-2OZ-CARTON-BOX',
        inputQuantity: 6,
        recipeType: 'max_capacity',
      }),
    ]),
  }),
  ten_pound_bulk: Object.freeze({
    label: '10 lb bulk product',
    providerSellUnitProfileKey: 'customer-each',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-each',
        profileName: '10 lb bulk product each',
        packageLevel: 'each',
        baseEachQuantity: 1,
        isDefault: true,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        fitModel: 'approved_recipe_only',
      }),
      profile({
        profileKey: 'customer-ship-case-1',
        profileName: '10 lb bulk ship-ready carton',
        packageLevel: 'case',
        baseEachQuantity: 1,
        ...AG12V2_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'required_from_child',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-ship-case-1', 'customer-each', 1),
    ]),
    recipes: Object.freeze([
      recipe({
        recipeKey: 'customer-ship-case-1',
        recipeName: 'Pack one 10 lb bulk product in AG12V2',
        inputProfileKey: 'customer-each',
        outputProfileKey: 'customer-ship-case-1',
        packagingMaterialCode: 'AG12V2',
        inputQuantity: 1,
        recipeType: 'ship_ready_unit',
        fulfillmentPolicy: 'case_required',
        remainderPolicy: 'block',
        inventoryEvidenceRequirement: 'each_assembly_allowed',
        assemblyPolicy: 'required',
      }),
    ]),
  }),
  twenty_pound_bulk: Object.freeze({
    label: '20 lb bulk product',
    providerSellUnitProfileKey: 'customer-each',
    profiles: Object.freeze([
      profile({
        profileKey: 'customer-each',
        profileName: '20 lb bulk product each',
        packageLevel: 'each',
        baseEachQuantity: 1,
        isDefault: true,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        fitModel: 'approved_recipe_only',
      }),
      profile({
        profileKey: 'customer-ship-case-1',
        profileName: '20 lb bulk ship-ready carton',
        packageLevel: 'case',
        baseEachQuantity: 1,
        ...TWENTY_POUND_BOX_DIMENSIONS,
        shipsAsOwnPackage: true,
        assemblyPolicy: 'required_from_child',
      }),
    ]),
    relationships: Object.freeze([
      relationship('customer-ship-case-1', 'customer-each', 1),
    ]),
    recipes: Object.freeze([
      recipe({
        recipeKey: 'customer-ship-case-1',
        recipeName: 'Pack one 20 lb bulk product in 20 lb box',
        inputProfileKey: 'customer-each',
        outputProfileKey: 'customer-ship-case-1',
        packagingMaterialCode: 'AG-20LB-BOX',
        inputQuantity: 1,
        recipeType: 'ship_ready_unit',
        fulfillmentPolicy: 'case_required',
        remainderPolicy: 'block',
        inventoryEvidenceRequirement: 'each_assembly_allowed',
        assemblyPolicy: 'required',
      }),
    ]),
  }),
})

export function validatePackClassManifest(packClasses = AG_PRODUCT_PACK_CLASSES) {
  const rank = new Map([
    ['each', 1],
    ['inner_pack', 2],
    ['case', 3],
    ['pallet', 4],
  ])
  const materialCodes = new Set(
    AG_PACKAGING_MATERIAL_DRAFTS.map((material) => material.code),
  )
  for (const [classKey, packClass] of Object.entries(packClasses)) {
    const profiles = new Map()
    const defaultProfiles = []
    for (const candidate of packClass.profiles) {
      if (!PROFILE_KEY_PATTERN.test(candidate.profileKey)) {
        fail(`${classKey} has an invalid profile key ${candidate.profileKey}`)
      }
      if (profiles.has(candidate.profileKey)) {
        fail(`${classKey} repeats profile ${candidate.profileKey}`)
      }
      if (!rank.has(candidate.packageLevel)) {
        fail(`${classKey} has an invalid package level`)
      }
      if (
        candidate.packageLevel === 'each'
        && candidate.baseEachQuantity !== 1
      ) {
        fail(`${classKey} each profile must contain exactly one base each`)
      }
      const dimensionsPresent = [
        candidate.lengthMm,
        candidate.widthMm,
        candidate.heightMm,
      ].filter((value) => value !== null).length
      if (dimensionsPresent !== 0 && dimensionsPresent !== 3) {
        fail(`${classKey} profile ${candidate.profileKey} has partial dimensions`)
      }
      if (
        candidate.grossWeightGrams === null
        && candidate.weightBasis !== 'unspecified'
      ) {
        fail(`${classKey} profile ${candidate.profileKey} invents a weight basis`)
      }
      if (
        candidate.fitModel === 'approved_recipe_only'
        && (
          !['customer_confirmed', 'measured', 'provider'].includes(
            candidate.evidenceType,
          )
          || !candidate.evidenceReference
        )
      ) {
        fail(
          `${classKey} recipe-only profile lacks explicit fit evidence`,
        )
      }
      if (candidate.isDefault) defaultProfiles.push(candidate.profileKey)
      profiles.set(candidate.profileKey, candidate)
    }
    if (defaultProfiles.length !== 1) {
      fail(`${classKey} must identify exactly one default provider sell unit`)
    }
    if (
      packClass.providerSellUnitProfileKey !== defaultProfiles[0]
      || !profiles.has(packClass.providerSellUnitProfileKey)
    ) {
      fail(`${classKey} provider sell unit must be its default pack profile`)
    }
    for (const candidate of packClass.relationships) {
      const parent = profiles.get(candidate.parentProfileKey)
      const child = profiles.get(candidate.childProfileKey)
      if (!parent || !child) fail(`${classKey} relationship references an unknown profile`)
      if (rank.get(parent.packageLevel) <= rank.get(child.packageLevel)) {
        fail(`${classKey} relationship parent must be a higher pack level`)
      }
      if (!Number.isSafeInteger(candidate.containedQuantity)
        || candidate.containedQuantity < 1) {
        fail(`${classKey} relationship quantity is invalid`)
      }
    }
    const recipeKeys = new Set()
    for (const candidate of packClass.recipes) {
      const input = profiles.get(candidate.inputProfileKey)
      const output = profiles.get(candidate.outputProfileKey)
      if (!input || !output) fail(`${classKey} recipe references an unknown profile`)
      if (rank.get(output.packageLevel) <= rank.get(input.packageLevel)) {
        fail(`${classKey} recipe output must be a higher pack level`)
      }
      if (output.assemblyPolicy === 'never') {
        fail(`${classKey} recipe cannot assemble a prepackaged profile`)
      }
      if (!materialCodes.has(candidate.packagingMaterialCode)) {
        fail(`${classKey} recipe references an unknown packaging material`)
      }
      if (
        candidate.minimumInputQuantity !== null
        && (
          candidate.recipeType !== 'max_capacity'
          || !Number.isSafeInteger(candidate.minimumInputQuantity)
          || candidate.minimumInputQuantity < 1
          || candidate.minimumInputQuantity > candidate.inputQuantity
        )
      ) {
        fail(`${classKey} recipe has an invalid minimum input quantity`)
      }
      if (
        candidate.contentCompatibilityKey !== null
        && !COMPATIBILITY_KEY_PATTERN.test(
          candidate.contentCompatibilityKey,
        )
      ) {
        fail(`${classKey} recipe has an invalid compatibility key`)
      }
      if (
        candidate.allowsMixedProducts
        && (
          candidate.recipeType !== 'max_capacity'
          || candidate.exclusiveContents
          || !candidate.contentCompatibilityKey
          || !['customer_confirmed', 'measured'].includes(
            candidate.fitEvidenceType,
          )
          || !candidate.fitEvidenceReference
        )
      ) {
        fail(`${classKey} recipe has unsafe mixed-product semantics`)
      }
      if (recipeKeys.has(candidate.recipeKey)) {
        fail(`${classKey} repeats recipe ${candidate.recipeKey}`)
      }
      recipeKeys.add(candidate.recipeKey)
    }
  }
  return true
}

export function parseAssignments(raw) {
  if (!raw) return null
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    fail('Assignment JSON is invalid')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('Assignments must be a JSON object keyed by pack class')
  }
  const unknownKeys = Object.keys(payload).filter(
    (key) => !Object.hasOwn(AG_PRODUCT_PACK_CLASSES, key),
  )
  if (unknownKeys.length > 0) {
    fail(`Unknown AG pack classes: ${unknownKeys.join(', ')}`)
  }
  const seen = new Set()
  const assignments = []
  for (const classKey of Object.keys(AG_PRODUCT_PACK_CLASSES).sort()) {
    const productGlobalIds = payload[classKey] ?? []
    if (!Array.isArray(productGlobalIds)) {
      fail(`${classKey} assignments must be an array of Product Global IDs`)
    }
    for (const rawGlobalId of productGlobalIds) {
      const productGlobalId = String(rawGlobalId || '').trim()
      if (!PRODUCT_GLOBAL_ID_PATTERN.test(productGlobalId)) {
        fail(`${classKey} contains an invalid Product Global ID`)
      }
      if (seen.has(productGlobalId)) {
        fail(`${productGlobalId} is assigned to more than one pack class`)
      }
      seen.add(productGlobalId)
      assignments.push({ classKey, productGlobalId })
    }
  }
  if (assignments.length > MAX_ASSIGNED_PRODUCTS) {
    fail(`Assignments exceed the ${MAX_ASSIGNED_PRODUCTS} product safety limit`)
  }
  return assignments.sort((left, right) => (
    left.productGlobalId.localeCompare(right.productGlobalId)
  ))
}

export function suggestedPackClass(product) {
  const value = `${product?.name || ''} ${product?.sku || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
  const hasTwoOunce = /\b2\s*(?:oz|ounces?)\b/.test(value)
  const hasSixOunce = /\b6\s*(?:oz|ounces?)\b/.test(value)
  const isDisplayCarton = /\b(?:display\s+)?carton\b/.test(value)
  const isTwelvePack = (
    /\bcase\s+(?:of\s+)?12\b/.test(value)
    || /\b12\s*[- ]?\s*(?:pack|pk|count|ct)\b/.test(value)
    || /\b12\s*[x×]\s*6\s*(?:oz|ounces?)\b/.test(value)
  )
  if (hasTwoOunce && isDisplayCarton) {
    return 'two_ounce_display_carton'
  }
  if (hasSixOunce && isTwelvePack) {
    return 'six_ounce_case_12'
  }
  const matches = []
  if (hasSixOunce) matches.push('six_ounce_bag')
  if (hasTwoOunce) matches.push('two_ounce_bag')
  if (/\b10\s*lb\b/.test(value)) matches.push('ten_pound_bulk')
  if (/\b20\s*lb\b/.test(value)) matches.push('twenty_pound_bulk')
  return matches.length === 1 ? matches[0] : null
}

function assignmentInput() {
  const pathArgument = process.argv.find((value) => value.startsWith('--assignments='))
  if (pathArgument) {
    const path = pathArgument.slice('--assignments='.length)
    if (!path) fail('--assignments requires a JSON file path')
    return readFileSync(path, 'utf8')
  }
  return environmentValue('AG_ALCHEMY_PACK_ASSIGNMENTS_JSON') || null
}

function actorInput() {
  const actorArgument = process.argv.find((value) => value.startsWith('--actor='))
  if (actorArgument) return actorArgument.slice('--actor='.length).trim()
  return environmentValue('AG_ALCHEMY_PACK_ACTOR_EMAIL')
}

function expectedPlanFingerprintInput() {
  const fingerprintArgument = process.argv.find(
    (value) => value.startsWith('--plan-fingerprint='),
  )
  if (fingerprintArgument) {
    return fingerprintArgument.slice('--plan-fingerprint='.length).trim()
  }
  return environmentValue('AG_ALCHEMY_PACK_PLAN_FINGERPRINT')
}

async function loadDatabaseIdentity(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
       (
         SELECT value ->> 'id'
         FROM app_settings
         WHERE key = 'deployment.database.identity'
       ) AS database_fingerprint`,
  )
  const identity = result.rows[0]
  assertTrustedDatabaseIdentity(identity)
  return identity
}

async function loadTarget(client, requestedActorEmail = '') {
  const organizations = await client.query(
    `SELECT id::text, name, reference_code
     FROM workspace_organizations
     WHERE lower(name) = lower($1)
     ORDER BY id`,
    [TARGET_ORGANIZATION_NAME],
  )
  if (organizations.rowCount !== 1) {
    fail(`Expected exactly one ${TARGET_ORGANIZATION_NAME} organization`)
  }
  const organization = organizations.rows[0]
  if (!UUID_PATTERN.test(organization.id)) {
    fail('AG Alchemy organization identity is invalid')
  }
  let actorEmail = null
  if (requestedActorEmail) {
    const normalizedActorEmail = requestedActorEmail.toLowerCase()
    const memberships = await client.query(
      `SELECT membership.user_email
     FROM app_user_organization_memberships membership
     JOIN app_users app_user
       ON app_user.email = membership.user_email
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
       AND membership.status = 'active'
       AND membership.role IN ('owner', 'admin')
       AND app_user.status = 'active'`,
      [organization.id, normalizedActorEmail],
    )
    if (memberships.rowCount !== 1) {
      fail(
        'The explicit AG pack actor must be an active AG Alchemy owner or administrator',
      )
    }
    actorEmail = memberships.rows[0].user_email
  }
  const pipelines = await client.query(
    `SELECT id::text, name
     FROM pipeline_spaces
     WHERE workspace_organization_id = $1::uuid
       AND is_default = true
       AND reference_access_disabled = false
     ORDER BY id`,
    [organization.id],
  )
  if (pipelines.rowCount !== 1) {
    fail('AG Alchemy must have exactly one active default CRM pipeline')
  }
  return {
    organization,
    pipeline: pipelines.rows[0],
    actorEmail,
  }
}

async function productSuggestions(client, target) {
  const products = await client.query(
    `SELECT reference_code, name, sku
     FROM crm_products
     WHERE pipeline_id = $1::uuid
       AND active = true
     ORDER BY lower(name), reference_code`,
    [target.pipeline.id],
  )
  return products.rows.map((product) => ({
    productGlobalId: product.reference_code,
    name: product.name,
    sku: product.sku,
    suggestedPackClass: suggestedPackClass(product),
  })).filter((product) => product.suggestedPackClass)
}

async function loadAssignedProducts(client, target, assignments) {
  if (assignments.length === 0) return new Map()
  const expected = assignments.map((assignment) => assignment.productGlobalId)
  const products = await client.query(
    `SELECT id::text, reference_code, name, sku, active
     FROM crm_products
     WHERE pipeline_id = $1::uuid
       AND reference_code = ANY($2::text[])
     ORDER BY reference_code
     FOR SHARE`,
    [target.pipeline.id, expected],
  )
  if (products.rowCount !== expected.length) {
    const found = new Set(products.rows.map((product) => product.reference_code))
    const missing = expected.filter((globalId) => !found.has(globalId))
    fail(`Assigned AG products were not found: ${missing.join(', ')}`)
  }
  for (const product of products.rows) {
    if (product.active !== true) {
      fail(`Assigned Product ${product.reference_code} is inactive`)
    }
  }
  return new Map(products.rows.map((product) => [product.reference_code, product]))
}

async function loadCurrentChannelStates(client, target, product) {
  const result = await client.query(
    `SELECT state.id::text, state.global_id,
            state.integration_account_id::text, state.provider,
            state.external_product_id, state.external_variant_id,
            state.normalized_status, state.provider_updated_at::text,
            state.observed_at::text, state.source_revision, state.source_hash,
            state.product_mapping_id::text,
            mapping.global_id AS product_mapping_global_id
     FROM operations_product_channel_states state
     JOIN operations_product_mappings mapping
       ON mapping.organization_id = state.organization_id
      AND mapping.integration_account_id = state.integration_account_id
      AND mapping.pipeline_id = state.pipeline_id
      AND mapping.id = state.product_mapping_id
      AND mapping.product_id = state.product_id
      AND mapping.external_variant_id = state.external_variant_id
     WHERE state.organization_id = $1::uuid
       AND state.pipeline_id = $2::uuid
       AND state.product_id = $3::uuid
       AND mapping.active = true
     ORDER BY state.integration_account_id, state.provider,
              state.external_variant_id
     FOR UPDATE OF state, mapping`,
    [target.organization.id, target.pipeline.id, product.id],
  )
  if (result.rowCount === 0) {
    fail(
      `Assigned Product ${product.reference_code} has no current exact provider channel state`,
    )
  }
  return result.rows
}

async function assertActorStillActive(client, target) {
  const result = await client.query(
    `SELECT membership.user_email
     FROM app_user_organization_memberships membership
     JOIN app_users app_user
       ON app_user.email = membership.user_email
     WHERE membership.organization_id = $1::uuid
       AND membership.user_email = $2
       AND membership.status = 'active'
       AND membership.role IN ('owner', 'admin')
       AND app_user.status = 'active'
     FOR SHARE OF membership, app_user`,
    [target.organization.id, target.actorEmail],
  )
  if (result.rowCount !== 1) {
    fail('The explicit AG pack actor is no longer active or authorized')
  }
}

function valuesCompatible(existing, expected, nullableKeys = []) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const existingValue = existing[key]
    if (
      nullableKeys.includes(key)
      && (expectedValue === null || expectedValue === 'unspecified')
      && existingValue !== undefined
    ) continue
    if (Number.isInteger(expectedValue)) {
      if (existingValue === null || Number(existingValue) !== expectedValue) return false
    } else if (existingValue !== expectedValue) {
      return false
    }
  }
  return true
}

export function legacyRecipeOnlyProfileUpgradeAllowed(
  existing,
  candidate,
  history,
) {
  return Boolean(
    existing
    && candidate
    && Number(history?.versionCount) === 1
    && Number(history?.maximumVersionNumber) === 1
    && Number(existing.version_number) === 1
    && Number(existing.row_version) === 0
    && existing.is_current === true
    && existing.lifecycle_state === 'customer_confirmed'
    && Number(existing.base_each_quantity) === 1
    && existing.unit_of_measure === 'each'
    && existing.length_mm === null
    && existing.width_mm === null
    && existing.height_mm === null
    && existing.dimension_basis === 'unspecified'
    && existing.gross_weight_grams === null
    && existing.weight_basis === 'unspecified'
    && existing.fit_model === 'rigid_3d'
    && existing.ships_as_own_package === false
    && existing.assembly_policy === 'never'
    && existing.evidence_type === 'customer_confirmed'
    && existing.evidence_reference === candidate.evidenceReference
    && existing.confirmed_at !== null
    && existing.source === 'customer_supplied'
    && candidate.baseEachQuantity === 1
    && candidate.lengthMm === null
    && candidate.widthMm === null
    && candidate.heightMm === null
    && candidate.dimensionBasis === 'unspecified'
    && candidate.grossWeightGrams === null
    && candidate.weightBasis === 'unspecified'
    && candidate.fitModel === 'approved_recipe_only'
    && candidate.shipsAsOwnPackage === false
    && candidate.assemblyPolicy === 'never'
    && candidate.evidenceType === 'customer_confirmed'
    && candidate.source === 'customer_supplied'
  )
}

function versionEndpointMatches(rowId, stagedProfile) {
  return rowId === stagedProfile.version.id
    || (
      stagedProfile.repair
      && rowId === stagedProfile.repair.previousVersionId
    )
}

export function providerPackMappingMatches(existing, expected) {
  return Boolean(
    existing
    && existing.product_id === expected.productId
    && existing.default_pack_profile_version_id === expected.profileVersionId
    && existing.external_product_id === expected.channelState.external_product_id
    && existing.provider_lifecycle_state
      === expected.channelState.normalized_status
    && existing.projection_state === 'current'
    && existing.source_revision === expected.channelState.source_revision
    && existing.source_hash === expected.channelState.source_hash
    && existing.provider_updated_at
      === expected.channelState.provider_updated_at
  )
}

export function starterMaterialRowMatches(row, expected) {
  return Boolean(
    row
    && expected
    && row.code === expected.code
    && row.name === expected.name
    && row.material_type === expected.materialType
    && Number(row.inner_length_mm) === expected.lengthMm
    && Number(row.inner_width_mm) === expected.widthMm
    && Number(row.inner_height_mm) === expected.heightMm
    && row.dimension_basis === 'inner'
    && row.dimension_evidence_type === 'legacy'
    && (
      row.dimension_evidence_reference === STARTER_EVIDENCE_REFERENCE
      || row.dimension_evidence_reference === null
    )
    && Number(row.tare_weight_grams) === expected.tareWeightGrams
    && Number(row.max_weight_grams) === expected.maxWeightGrams
    && row.unit_cost_minor === null
    && row.currency === null
    && row.status === 'draft'
    && row.source === 'starter_assortment'
  )
}

async function loadSyntheticStarterCleanupPlan(client, target) {
  const expectedCodes = AG_SYNTHETIC_STARTER_MATERIALS.map(
    (material) => material.code,
  )
  const materials = await client.query(
    `SELECT id::text, global_id, code, name, material_type,
            inner_length_mm, inner_width_mm, inner_height_mm,
            dimension_basis, dimension_evidence_type,
            dimension_evidence_reference, tare_weight_grams,
            max_weight_grams, unit_cost_minor::text, currency, status, source,
            row_version::text
     FROM operations_packaging_materials
     WHERE organization_id = $1::uuid
       AND (
         source = 'starter_assortment'
         OR code = ANY($2::text[])
       )
     ORDER BY code, id
     FOR UPDATE`,
    [target.organization.id, expectedCodes],
  )
  if (
    materials.rowCount !== 0
    && materials.rowCount !== AG_SYNTHETIC_STARTER_MATERIALS.length
  ) {
    fail('AG Alchemy synthetic starter assortment is partial or conflicting')
  }
  const expectedByCode = new Map(
    AG_SYNTHETIC_STARTER_MATERIALS.map((material) => [
      material.code,
      material,
    ]),
  )
  for (const row of materials.rows) {
    if (!starterMaterialRowMatches(row, expectedByCode.get(row.code))) {
      fail(`Starter packaging material ${row.code} is not an untouched synthetic draft`)
    }
  }
  const allMaterials = await client.query(
    `SELECT id::text, code, source, status
     FROM operations_packaging_materials
     WHERE organization_id = $1::uuid
     ORDER BY code, id
     FOR UPDATE`,
    [target.organization.id],
  )
  const starterIds = new Set(materials.rows.map((row) => row.id))
  const retainedMaterials = allMaterials.rows.filter(
    (row) => !starterIds.has(row.id),
  )
  const retainedCodes = new Set(retainedMaterials.map((row) => row.code))
  const missingCustomerMaterialCount = AG_PACKAGING_MATERIAL_DRAFTS.filter(
    (material) => !retainedCodes.has(material.code),
  ).length
  const projectedMaterialCount =
    retainedMaterials.length + missingCustomerMaterialCount
  if (projectedMaterialCount > 8) {
    fail('AG Alchemy packaging plan would exceed the eight-material limit')
  }

  const referenceTables = await client.query(
    `SELECT conrelid::regclass::text AS table_name
     FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid = 'operations_packaging_materials'::regclass
     ORDER BY conrelid::regclass::text`,
  )
  const actualReferenceTables = new Set(referenceTables.rows.map((row) => (
    row.table_name.split('.').at(-1)
  )))
  const expectedReferenceTables = new Set([
    'operations_approved_pack_recipes',
    'operations_cartonization_rate_evidence_packages',
    'operations_packaging_material_stock',
  ])
  if (
    actualReferenceTables.size !== expectedReferenceTables.size
    || [...actualReferenceTables].some(
      (tableName) => !expectedReferenceTables.has(tableName),
    )
  ) {
    fail('Packaging-material reference topology changed; starter cleanup is blocked')
  }

  if (materials.rowCount === 0) {
    return {
      materials: [],
      stockRows: [],
      materialCount: 0,
      stockRowCount: 0,
      retainedMaterialCount: retainedMaterials.length,
      projectedMaterialCount,
      referenceTables: [...actualReferenceTables].sort(),
    }
  }
  const materialIds = materials.rows.map((row) => row.id)
  const recipes = await client.query(
    `SELECT id::text, global_id
     FROM operations_approved_pack_recipes
     WHERE organization_id = $1::uuid
       AND packaging_material_id = ANY($2::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [target.organization.id, materialIds],
  )
  if (recipes.rowCount > 0) {
    fail('Synthetic starter materials have pack-recipe references')
  }
  const cartonizationRateEvidencePackages = await client.query(
    `SELECT evidence_id::text, package_key
     FROM operations_cartonization_rate_evidence_packages
     WHERE organization_id = $1::uuid
       AND packaging_material_id = ANY($2::uuid[])
     ORDER BY evidence_id, package_key
     FOR UPDATE`,
    [target.organization.id, materialIds],
  )
  if (cartonizationRateEvidencePackages.rowCount > 0) {
    fail(
      'Synthetic starter materials have immutable cartonization-rate evidence references',
    )
  }
  const stock = await client.query(
    `SELECT id::text, global_id, packaging_material_id::text,
            warehouse_id::text, is_available, on_hand_quantity,
            reorder_point_quantity, reorder_to_quantity, row_version::text
     FROM operations_packaging_material_stock
     WHERE organization_id = $1::uuid
       AND packaging_material_id = ANY($2::uuid[])
     ORDER BY packaging_material_id, warehouse_id, id
     FOR UPDATE`,
    [target.organization.id, materialIds],
  )
  for (const row of stock.rows) {
    if (
      row.is_available
      || row.on_hand_quantity !== null
      || row.reorder_point_quantity !== null
      || row.reorder_to_quantity !== null
    ) {
      fail('Synthetic starter material stock contains operator-maintained facts')
    }
  }
  return {
    materials: materials.rows,
    stockRows: stock.rows,
    materialCount: materials.rowCount,
    stockRowCount: stock.rowCount,
    retainedMaterialCount: retainedMaterials.length,
    projectedMaterialCount,
    referenceTables: [...actualReferenceTables].sort(),
  }
}

async function deleteSyntheticStarterDrafts(client, target, cleanupPlan) {
  if (cleanupPlan.materialCount === 0) {
    return { materialsDeleted: 0, stockRowsDeleted: 0 }
  }
  const materialIds = cleanupPlan.materials.map((row) => row.id)
  const deletedStock = await client.query(
    `DELETE FROM operations_packaging_material_stock
     WHERE organization_id = $1::uuid
       AND packaging_material_id = ANY($2::uuid[])
     RETURNING id`,
    [target.organization.id, materialIds],
  )
  if (deletedStock.rowCount !== cleanupPlan.stockRowCount) {
    fail('Synthetic starter stock changed during guarded cleanup')
  }
  const deletedMaterials = await client.query(
    `DELETE FROM operations_packaging_materials
     WHERE organization_id = $1::uuid
       AND id = ANY($2::uuid[])
       AND source = 'starter_assortment'
       AND status = 'draft'
     RETURNING id`,
    [target.organization.id, materialIds],
  )
  if (deletedMaterials.rowCount !== cleanupPlan.materialCount) {
    fail('Synthetic starter materials changed during guarded cleanup')
  }
  return {
    materialsDeleted: deletedMaterials.rowCount,
    stockRowsDeleted: deletedStock.rowCount,
  }
}

export function materialEvidencePatchRequired(row, material) {
  return (
    (row.inner_length_mm === null && material.lengthMm !== null)
    || (row.inner_width_mm === null && material.widthMm !== null)
    || (row.inner_height_mm === null && material.heightMm !== null)
    || row.dimension_evidence_type === 'unknown'
    || row.dimension_evidence_reference === null
    || row.dimension_confirmed_at === null
    || row.dimension_confirmed_by === null
  )
}

async function stageMaterial(client, target, material) {
  const existing = await client.query(
    `SELECT id::text, global_id, code, name, material_type,
            inner_length_mm, inner_width_mm, inner_height_mm,
            dimension_basis, dimension_evidence_type,
            dimension_evidence_reference, dimension_confirmed_at,
            dimension_confirmed_by, tare_weight_grams,
            max_weight_grams, unit_cost_minor::text, currency, status, source
     FROM operations_packaging_materials
     WHERE organization_id = $1::uuid
       AND code = $2
     FOR UPDATE`,
    [target.organization.id, material.code],
  )
  if (existing.rowCount > 1) fail(`Packaging material ${material.code} is duplicated`)
  if (existing.rowCount === 1) {
    const row = existing.rows[0]
    if (
      row.name !== material.name
      || row.material_type !== material.materialType
      || row.source !== 'customer_supplied'
      || row.status !== 'draft'
    ) {
      fail(`Packaging material ${material.code} conflicts with an existing record`)
    }
    for (const key of ['lengthMm', 'widthMm', 'heightMm']) {
      const column = {
        lengthMm: 'inner_length_mm',
        widthMm: 'inner_width_mm',
        heightMm: 'inner_height_mm',
      }[key]
      const supplied = material[key]
      if (
        supplied !== null
        && row[column] !== null
        && Number(row[column]) !== supplied
      ) {
        fail(`Packaging material ${material.code} has conflicting dimensions`)
      }
    }
    if (!materialEvidencePatchRequired(row, material)) {
      return { ...row, disposition: 'reused' }
    }
    const updated = await client.query(
      `UPDATE operations_packaging_materials
       SET inner_length_mm = COALESCE(inner_length_mm, $3),
           inner_width_mm = COALESCE(inner_width_mm, $4),
           inner_height_mm = COALESCE(inner_height_mm, $5),
           dimension_evidence_type = CASE
             WHEN dimension_evidence_type = 'unknown'
               THEN 'customer_confirmed'
             ELSE dimension_evidence_type
           END,
           dimension_evidence_reference = COALESCE(
             dimension_evidence_reference, $6
           ),
           dimension_confirmed_at = now(),
           dimension_confirmed_by = $7,
           updated_by = $7,
           updated_at = now(),
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
       RETURNING id::text, global_id`,
      [
        target.organization.id,
        row.id,
        material.lengthMm,
        material.widthMm,
        material.heightMm,
        material.dimensionEvidenceReference,
        target.actorEmail,
      ],
    )
    return { ...row, ...updated.rows[0], disposition: 'updated' }
  }
  const inserted = await client.query(
    `INSERT INTO operations_packaging_materials (
       organization_id, code, name, material_type,
       inner_length_mm, inner_width_mm, inner_height_mm,
       dimension_basis, dimension_evidence_type,
       dimension_evidence_reference, dimension_confirmed_at,
       dimension_confirmed_by, tare_weight_grams, max_weight_grams,
       unit_cost_minor, currency, status, source, created_by, updated_by
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       now(), $11, NULL, NULL, NULL, NULL, 'draft', 'customer_supplied',
       $11, $11
     )
     RETURNING id::text, global_id`,
    [
      target.organization.id,
      material.code,
      material.name,
      material.materialType,
      material.lengthMm,
      material.widthMm,
      material.heightMm,
      material.dimensionBasis,
      material.dimensionEvidenceType,
      material.dimensionEvidenceReference,
      target.actorEmail,
    ],
  )
  return { ...inserted.rows[0], disposition: 'created' }
}

async function stageProfile(client, target, product, candidate) {
  const profiles = await client.query(
    `SELECT id::text, global_id, profile_name, package_level,
            is_default, status
     FROM operations_product_pack_profiles
     WHERE organization_id = $1::uuid
       AND product_id = $2::uuid
       AND profile_key = $3
     FOR UPDATE`,
    [
      target.organization.id,
      product.id,
      candidate.profileKey,
    ],
  )
  let profileRow
  let profileDisposition = 'reused'
  if (profiles.rowCount === 0) {
    const inserted = await client.query(
      `INSERT INTO operations_product_pack_profiles (
         organization_id, pipeline_id, product_id, profile_key, profile_name,
         package_level, is_default, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         $7, 'draft', $8, $8
       )
       RETURNING id::text, global_id, profile_name, package_level,
                 is_default, status`,
      [
        target.organization.id,
        target.pipeline.id,
        product.id,
        candidate.profileKey,
        candidate.profileName,
        candidate.packageLevel,
        candidate.isDefault,
        target.actorEmail,
      ],
    )
    profileRow = inserted.rows[0]
    profileDisposition = 'created'
  } else if (profiles.rowCount === 1) {
    profileRow = profiles.rows[0]
    if (
      profileRow.profile_name !== candidate.profileName
      || profileRow.package_level !== candidate.packageLevel
      || profileRow.is_default !== candidate.isDefault
      || profileRow.status !== 'draft'
    ) {
      fail(
        `${product.reference_code} profile ${candidate.profileKey} conflicts with an existing profile`,
      )
    }
  } else {
    fail(`${product.reference_code} profile ${candidate.profileKey} is duplicated`)
  }

  const versions = await client.query(
    `SELECT id::text, global_id, version_number, lifecycle_state,
            base_each_quantity, unit_of_measure, length_mm, width_mm,
            height_mm, dimension_basis, gross_weight_grams, weight_basis,
            fit_model, ships_as_own_package, assembly_policy, evidence_type,
            evidence_reference, confirmed_at, source, is_current,
            row_version::text
     FROM operations_product_pack_profile_versions
     WHERE organization_id = $1::uuid
       AND profile_id = $2::uuid
     ORDER BY version_number, id
     FOR UPDATE`,
    [target.organization.id, profileRow.id],
  )
  const currentVersions = versions.rows.filter((row) => row.is_current)
  if (currentVersions.length > 1) {
    fail(`${product.reference_code} profile ${candidate.profileKey} has multiple current versions`)
  }
  let versionNumber = 1
  let repair = null
  if (currentVersions.length === 1) {
    const version = currentVersions[0]
    const compatible = valuesCompatible(version, {
      base_each_quantity: candidate.baseEachQuantity,
      unit_of_measure: 'each',
      length_mm: candidate.lengthMm,
      width_mm: candidate.widthMm,
      height_mm: candidate.heightMm,
      dimension_basis: candidate.dimensionBasis,
      gross_weight_grams: candidate.grossWeightGrams,
      weight_basis: candidate.weightBasis,
      fit_model: candidate.fitModel,
      ships_as_own_package: candidate.shipsAsOwnPackage,
      assembly_policy: candidate.assemblyPolicy,
      source: candidate.source,
    }, [
      'length_mm',
      'width_mm',
      'height_mm',
      'dimension_basis',
      'gross_weight_grams',
      'weight_basis',
    ])
    if (compatible && version.lifecycle_state === 'customer_confirmed') {
      return {
        profile: profileRow,
        version,
        disposition: profileDisposition === 'created' ? 'created' : 'reused',
        repair: null,
      }
    }
    const history = {
      versionCount: versions.rows.length,
      maximumVersionNumber: Math.max(
        ...versions.rows.map((row) => Number(row.version_number)),
      ),
    }
    if (!legacyRecipeOnlyProfileUpgradeAllowed(version, candidate, history)) {
      fail(
        `${product.reference_code} profile ${candidate.profileKey} has conflicting current facts`,
      )
    }
    const superseded = await client.query(
      `UPDATE operations_product_pack_profile_versions
       SET lifecycle_state = 'superseded',
           is_current = false,
           effective_to = GREATEST(
             now(), effective_from + interval '1 microsecond'
           ),
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $3::bigint
         AND is_current = true
         AND lifecycle_state = 'customer_confirmed'
         AND fit_model = 'rigid_3d'
       RETURNING id::text, global_id`,
      [
        target.organization.id,
        version.id,
        version.row_version,
      ],
    )
    if (superseded.rowCount !== 1) {
      fail(
        `${product.reference_code} legacy pack profile changed during repair`,
      )
    }
    versionNumber = Number(version.version_number) + 1
    repair = {
      previousVersionId: version.id,
      previousVersionGlobalId: version.global_id,
      previousVersionNumber: Number(version.version_number),
      previousRowVersion: Number(version.row_version),
      previousFitModel: version.fit_model,
      replacementVersionNumber: versionNumber,
    }
  } else if (versions.rowCount > 0) {
    fail(
      `${product.reference_code} profile ${candidate.profileKey} has history but no current version`,
    )
  }

  const version = await client.query(
    `INSERT INTO operations_product_pack_profile_versions (
       organization_id, pipeline_id, product_id, profile_id, version_number,
       lifecycle_state, base_each_quantity, unit_of_measure,
       length_mm, width_mm, height_mm, dimension_basis,
       gross_weight_grams, weight_basis, fit_model, ships_as_own_package,
       assembly_policy, evidence_type, evidence_reference,
       confirmed_at, confirmed_by, source, is_current, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
       'customer_confirmed', $6, 'each', $7, $8, $9, $10,
       $11, $12, $13, $14, $15, 'customer_confirmed', $16,
       now(), $17, 'customer_supplied', true, $17
     )
     RETURNING id::text, global_id, version_number, lifecycle_state,
               row_version::text`,
    [
      target.organization.id,
      target.pipeline.id,
      product.id,
      profileRow.id,
      versionNumber,
      candidate.baseEachQuantity,
      candidate.lengthMm,
      candidate.widthMm,
      candidate.heightMm,
      candidate.dimensionBasis,
      candidate.grossWeightGrams,
      candidate.weightBasis,
      candidate.fitModel,
      candidate.shipsAsOwnPackage,
      candidate.assemblyPolicy,
      candidate.evidenceReference,
      target.actorEmail,
    ],
  )
  return {
    profile: profileRow,
    version: version.rows[0],
    disposition: repair ? 'versioned' : 'created',
    repair,
  }
}

async function stageProviderPackMapping(
  client,
  target,
  product,
  channelState,
  sellUnitProfile,
) {
  const existing = await client.query(
    `SELECT id::text, global_id, product_id::text,
            external_product_id,
            default_pack_profile_version_id::text,
            provider_lifecycle_state, projection_state,
            source_revision, source_hash, provider_updated_at::text,
            row_version::text
     FROM operations_commerce_variant_pack_mappings
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid
       AND provider = $3
       AND external_variant_id = $4
       AND is_current = true
     FOR UPDATE`,
    [
      target.organization.id,
      channelState.integration_account_id,
      channelState.provider,
      channelState.external_variant_id,
    ],
  )
  if (existing.rowCount > 1) {
    fail('Provider variant has multiple current pack mappings')
  }
  const expected = {
    productId: product.id,
    profileVersionId: sellUnitProfile.version.id,
    channelState,
  }
  if (existing.rowCount === 1) {
    const row = existing.rows[0]
    if (row.product_id !== product.id) {
      fail(
        `${product.reference_code} provider variant has a conflicting pack mapping`,
      )
    }
    const exactProfile = row.default_pack_profile_version_id
      === sellUnitProfile.version.id
    const repairedProfile = Boolean(
      sellUnitProfile.repair
      && row.default_pack_profile_version_id
        === sellUnitProfile.repair.previousVersionId,
    )
    if (!exactProfile && !repairedProfile) {
      fail(
        `${product.reference_code} provider variant has a conflicting pack mapping`,
      )
    }
    if (providerPackMappingMatches(row, expected)) {
      return { ...row, disposition: 'reused' }
    }
    if (
      repairedProfile
      && !providerPackMappingMatches(row, {
        ...expected,
        profileVersionId: sellUnitProfile.repair.previousVersionId,
      })
    ) {
      fail(
        `${product.reference_code} legacy pack mapping does not match current channel evidence`,
      )
    }
    const superseded = await client.query(
      `UPDATE operations_commerce_variant_pack_mappings
       SET projection_state = 'stale',
           is_current = false,
           effective_to = GREATEST(
             now(), effective_from + interval '1 microsecond'
           ),
           row_version = row_version + 1,
           updated_by = $3,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $4::bigint
         AND is_current = true
       RETURNING id`,
      [
        target.organization.id,
        row.id,
        target.actorEmail,
        row.row_version,
      ],
    )
    if (superseded.rowCount !== 1) {
      fail(
        `${product.reference_code} provider pack mapping changed during staging`,
      )
    }
  }
  const inserted = await client.query(
    `INSERT INTO operations_commerce_variant_pack_mappings (
       organization_id, integration_account_id, pipeline_id, product_id,
       provider, external_product_id, external_variant_id,
       default_pack_profile_version_id, provider_lifecycle_state,
       projection_state, source_revision, source_hash,
       provider_updated_at, observed_at, is_current, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid,
       $9, 'current', $10, $11, $12::timestamptz, $13::timestamptz,
       true, $14, $14
     )
     RETURNING id::text, global_id`,
    [
      target.organization.id,
      channelState.integration_account_id,
      target.pipeline.id,
      product.id,
      channelState.provider,
      channelState.external_product_id,
      channelState.external_variant_id,
      sellUnitProfile.version.id,
      channelState.normalized_status,
      channelState.source_revision,
      channelState.source_hash,
      channelState.provider_updated_at,
      channelState.observed_at,
      target.actorEmail,
    ],
  )
  return {
    ...inserted.rows[0],
    disposition: existing.rowCount === 1 ? 'versioned' : 'created',
    replacedMapping: existing.rowCount === 1
      ? {
          previousMappingGlobalId: existing.rows[0].global_id,
          previousMappingRowVersion: Number(existing.rows[0].row_version),
        }
      : null,
  }
}

async function stageRelationship(
  client,
  target,
  product,
  candidate,
  profiles,
) {
  const parent = profiles.get(candidate.parentProfileKey)
  const child = profiles.get(candidate.childProfileKey)
  const existing = await client.query(
    `SELECT relationship.id::text, relationship.global_id,
            relationship.parent_profile_version_id::text,
            relationship.child_profile_version_id::text,
            relationship.contained_quantity, relationship.evidence_type,
            relationship.evidence_reference, relationship.lifecycle_state,
            relationship.source, relationship.row_version::text
     FROM operations_product_pack_relationships relationship
     JOIN operations_product_pack_profile_versions parent_version
       ON parent_version.organization_id = relationship.organization_id
      AND parent_version.id = relationship.parent_profile_version_id
     JOIN operations_product_pack_profile_versions child_version
       ON child_version.organization_id = relationship.organization_id
      AND child_version.id = relationship.child_profile_version_id
     WHERE relationship.organization_id = $1::uuid
       AND relationship.product_id = $2::uuid
       AND parent_version.profile_id = $3::uuid
       AND child_version.profile_id = $4::uuid
       AND relationship.is_current = true
     FOR UPDATE OF relationship`,
    [
      target.organization.id,
      product.id,
      parent.profile.id,
      child.profile.id,
    ],
  )
  if (existing.rowCount > 1) fail('Pack relationship is duplicated')
  let replacedRelationship = null
  if (existing.rowCount === 1) {
    const row = existing.rows[0]
    if (
      Number(row.contained_quantity) !== candidate.containedQuantity
      || row.evidence_type !== candidate.evidenceType
      || row.evidence_reference !== candidate.evidenceReference
      || row.lifecycle_state !== 'customer_confirmed'
      || row.source !== 'customer_supplied'
      || !versionEndpointMatches(
        row.parent_profile_version_id,
        parent,
      )
      || !versionEndpointMatches(
        row.child_profile_version_id,
        child,
      )
    ) {
      fail(`${product.reference_code} has a conflicting pack relationship`)
    }
    const exactEndpoints = (
      row.parent_profile_version_id === parent.version.id
      && row.child_profile_version_id === child.version.id
    )
    if (exactEndpoints) return { ...row, disposition: 'reused' }
    const retired = await client.query(
      `UPDATE operations_product_pack_relationships
       SET lifecycle_state = 'retired',
           is_current = false,
           effective_to = GREATEST(
             now(), effective_from + interval '1 microsecond'
           ),
           row_version = row_version + 1
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $3::bigint
         AND is_current = true
         AND lifecycle_state = 'customer_confirmed'
       RETURNING id`,
      [
        target.organization.id,
        row.id,
        row.row_version,
      ],
    )
    if (retired.rowCount !== 1) {
      fail(`${product.reference_code} pack relationship changed during repair`)
    }
    replacedRelationship = {
      previousRelationshipGlobalId: row.global_id,
      previousRelationshipRowVersion: Number(row.row_version),
    }
  }
  const inserted = await client.query(
    `INSERT INTO operations_product_pack_relationships (
       organization_id, pipeline_id, product_id,
       parent_profile_version_id, child_profile_version_id,
       contained_quantity, evidence_type, evidence_reference,
       lifecycle_state, source, is_current, created_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6, 'customer_confirmed', $7, 'customer_confirmed',
       'customer_supplied', true, $8
     )
     RETURNING id::text, global_id, lifecycle_state`,
    [
      target.organization.id,
      target.pipeline.id,
      product.id,
      parent.version.id,
      child.version.id,
      candidate.containedQuantity,
      candidate.evidenceReference,
      target.actorEmail,
    ],
  )
  return {
    ...inserted.rows[0],
    disposition: replacedRelationship ? 'versioned' : 'created',
    replacedRelationship,
  }
}

async function stageRecipe(
  client,
  target,
  product,
  candidate,
  profiles,
  materials,
) {
  const input = profiles.get(candidate.inputProfileKey)
  const output = profiles.get(candidate.outputProfileKey)
  const material = materials.get(candidate.packagingMaterialCode)
  const existing = await client.query(
    `SELECT id::text, global_id, version_number, recipe_name,
            input_pack_profile_version_id::text,
            output_pack_profile_version_id::text, packaging_material_id::text,
            input_quantity, output_quantity, packaging_material_quantity,
            recipe_type, fulfillment_policy, remainder_policy,
            inventory_evidence_requirement, assembly_policy,
            exclusive_contents, minimum_input_quantity,
            content_compatibility_key, allows_mixed_products,
            lifecycle_state, fit_evidence_type, fit_evidence_reference,
            confirmed_at, source, row_version::text
     FROM operations_approved_pack_recipes
     WHERE organization_id = $1::uuid
       AND product_id = $2::uuid
       AND recipe_key = $3
       AND is_current = true
     FOR UPDATE`,
    [target.organization.id, product.id, candidate.recipeKey],
  )
  if (existing.rowCount > 1) fail(`${candidate.recipeKey} is duplicated`)
  let versionNumber = 1
  let replacedRecipe = null
  if (existing.rowCount === 1) {
    const row = existing.rows[0]
    const semanticFactsCompatible = valuesCompatible(row, {
      recipe_name: candidate.recipeName,
      packaging_material_id: material.id,
      input_quantity: candidate.inputQuantity,
      output_quantity: candidate.outputQuantity,
      packaging_material_quantity: candidate.packagingMaterialQuantity,
      recipe_type: candidate.recipeType,
      fulfillment_policy: candidate.fulfillmentPolicy,
      remainder_policy: candidate.remainderPolicy,
      inventory_evidence_requirement: candidate.inventoryEvidenceRequirement,
      assembly_policy: candidate.assemblyPolicy,
      exclusive_contents: candidate.exclusiveContents,
      minimum_input_quantity: candidate.minimumInputQuantity,
      content_compatibility_key: candidate.contentCompatibilityKey,
      allows_mixed_products: candidate.allowsMixedProducts,
      source: candidate.source,
    })
    if (
      !semanticFactsCompatible
      || row.lifecycle_state !== 'customer_confirmed'
      || row.fit_evidence_type !== candidate.fitEvidenceType
      || row.fit_evidence_reference !== candidate.fitEvidenceReference
      || row.confirmed_at === null
      || !versionEndpointMatches(
        row.input_pack_profile_version_id,
        input,
      )
      || !versionEndpointMatches(
        row.output_pack_profile_version_id,
        output,
      )
    ) {
      fail(`${product.reference_code} recipe ${candidate.recipeKey} conflicts`)
    }
    const exactEndpoints = (
      row.input_pack_profile_version_id === input.version.id
      && row.output_pack_profile_version_id === output.version.id
    )
    if (exactEndpoints) return { ...row, disposition: 'reused' }
    const retired = await client.query(
      `UPDATE operations_approved_pack_recipes
       SET lifecycle_state = 'retired',
           is_current = false,
           effective_to = GREATEST(
             now(), effective_from + interval '1 microsecond'
           ),
           row_version = row_version + 1,
           updated_by = $4,
           updated_at = now()
       WHERE organization_id = $1::uuid
         AND id = $2::uuid
         AND row_version = $3::bigint
         AND is_current = true
         AND lifecycle_state = 'customer_confirmed'
       RETURNING id`,
      [
        target.organization.id,
        row.id,
        row.row_version,
        target.actorEmail,
      ],
    )
    if (retired.rowCount !== 1) {
      fail(
        `${product.reference_code} recipe ${candidate.recipeKey} changed during repair`,
      )
    }
    versionNumber = Number(row.version_number) + 1
    replacedRecipe = {
      previousRecipeGlobalId: row.global_id,
      previousRecipeVersionNumber: Number(row.version_number),
      previousRecipeRowVersion: Number(row.row_version),
      replacementRecipeVersionNumber: versionNumber,
    }
  }
  const inserted = await client.query(
    `INSERT INTO operations_approved_pack_recipes (
       organization_id, pipeline_id, product_id, recipe_key, recipe_name,
       version_number, input_pack_profile_version_id,
       output_pack_profile_version_id, packaging_material_id,
       input_quantity, output_quantity, packaging_material_quantity,
       recipe_type, fulfillment_policy, remainder_policy,
       inventory_evidence_requirement, assembly_policy, exclusive_contents,
       minimum_input_quantity, content_compatibility_key,
       allows_mixed_products,
       lifecycle_state, fit_evidence_type, fit_evidence_reference,
       confirmed_at, confirmed_by, source, is_current, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::uuid,
       $9::uuid, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21,
       'customer_confirmed', 'customer_confirmed', $22, now(), $23,
       'customer_supplied', true, $23, $23
     )
     RETURNING id::text, global_id, version_number, lifecycle_state,
               row_version::text`,
    [
      target.organization.id,
      target.pipeline.id,
      product.id,
      candidate.recipeKey,
      candidate.recipeName,
      versionNumber,
      input.version.id,
      output.version.id,
      material.id,
      candidate.inputQuantity,
      candidate.outputQuantity,
      candidate.packagingMaterialQuantity,
      candidate.recipeType,
      candidate.fulfillmentPolicy,
      candidate.remainderPolicy,
      candidate.inventoryEvidenceRequirement,
      candidate.assemblyPolicy,
      candidate.exclusiveContents,
      candidate.minimumInputQuantity,
      candidate.contentCompatibilityKey,
      candidate.allowsMixedProducts,
      candidate.fitEvidenceReference,
      target.actorEmail,
    ],
  )
  return {
    ...inserted.rows[0],
    disposition: replacedRecipe ? 'versioned' : 'created',
    replacedRecipe,
  }
}

async function stageHierarchy(
  client,
  target,
  assignments,
  apply,
  { databaseFingerprint, expectedPlanFingerprint },
) {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [`operations:ag-pack-hierarchy:${target.organization.id}:${SCRIPT_VERSION}`],
    )
    await assertActorStillActive(client, target)
    const products = await loadAssignedProducts(
      client,
      target,
      assignments,
    )
    const channelStatesByProduct = new Map()
    for (const assignment of assignments) {
      const product = products.get(assignment.productGlobalId)
      channelStatesByProduct.set(
        assignment.productGlobalId,
        await loadCurrentChannelStates(client, target, product),
      )
    }
    const cleanupPlan = await loadSyntheticStarterCleanupPlan(client, target)
    const cleanup = await deleteSyntheticStarterDrafts(
      client,
      target,
      cleanupPlan,
    )
    const materialRows = new Map()
    const dispositions = {
      syntheticStarterMaterialsDeleted: cleanup.materialsDeleted,
      syntheticStarterStockRowsDeleted: cleanup.stockRowsDeleted,
      materialsCreated: 0,
      materialsUpdated: 0,
      materialsReused: 0,
      profilesCreated: 0,
      profilesVersioned: 0,
      profilesReused: 0,
      providerMappingsCreated: 0,
      providerMappingsVersioned: 0,
      providerMappingsReused: 0,
      relationshipsCreated: 0,
      relationshipsVersioned: 0,
      relationshipsReused: 0,
      recipesCreated: 0,
      recipesVersioned: 0,
      recipesReused: 0,
    }
    for (const material of AG_PACKAGING_MATERIAL_DRAFTS) {
      const row = await stageMaterial(client, target, material)
      materialRows.set(material.code, row)
      const dispositionKey = {
        created: 'materialsCreated',
        updated: 'materialsUpdated',
        reused: 'materialsReused',
      }[row.disposition]
      dispositions[dispositionKey] += 1
    }

    const productResults = []
    for (const assignment of assignments) {
      const product = products.get(assignment.productGlobalId)
      const packClass = AG_PRODUCT_PACK_CLASSES[assignment.classKey]
      const profiles = new Map()
      const profileRepairs = []
      for (const candidate of packClass.profiles) {
        const row = await stageProfile(client, target, product, candidate)
        profiles.set(candidate.profileKey, row)
        const dispositionKey = {
          created: 'profilesCreated',
          versioned: 'profilesVersioned',
          reused: 'profilesReused',
        }[row.disposition]
        dispositions[dispositionKey] += 1
        if (row.repair) {
          profileRepairs.push({
            profileKey: candidate.profileKey,
            previousVersionGlobalId:
              row.repair.previousVersionGlobalId,
            previousVersionNumber:
              row.repair.previousVersionNumber,
            previousRowVersion:
              row.repair.previousRowVersion,
            previousFitModel:
              row.repair.previousFitModel,
            replacementVersionNumber:
              row.repair.replacementVersionNumber,
          })
        }
      }
      const sellUnitProfile = profiles.get(
        packClass.providerSellUnitProfileKey,
      )
      const providerMappings = []
      for (
        const channelState
        of channelStatesByProduct.get(assignment.productGlobalId)
      ) {
        const row = await stageProviderPackMapping(
          client,
          target,
          product,
          channelState,
          sellUnitProfile,
        )
        providerMappings.push({
          provider: channelState.provider,
          externalVariantId: channelState.external_variant_id,
          sourceRevision: channelState.source_revision,
          sourceHash: channelState.source_hash,
          disposition: row.disposition,
          replacedMapping: row.replacedMapping || null,
        })
        const dispositionKey = {
          created: 'providerMappingsCreated',
          versioned: 'providerMappingsVersioned',
          reused: 'providerMappingsReused',
        }[row.disposition]
        dispositions[dispositionKey] += 1
      }
      const relationshipResults = []
      for (const candidate of packClass.relationships) {
        const row = await stageRelationship(
          client,
          target,
          product,
          candidate,
          profiles,
        )
        const dispositionKey = {
          created: 'relationshipsCreated',
          versioned: 'relationshipsVersioned',
          reused: 'relationshipsReused',
        }[row.disposition]
        dispositions[dispositionKey] += 1
        relationshipResults.push({
          parentProfileKey: candidate.parentProfileKey,
          childProfileKey: candidate.childProfileKey,
          containedQuantity: candidate.containedQuantity,
          disposition: row.disposition,
          replacedRelationship: row.replacedRelationship || null,
        })
      }
      const recipeResults = []
      for (const candidate of packClass.recipes) {
        const row = await stageRecipe(
          client,
          target,
          product,
          candidate,
          profiles,
          materialRows,
        )
        const dispositionKey = {
          created: 'recipesCreated',
          versioned: 'recipesVersioned',
          reused: 'recipesReused',
        }[row.disposition]
        dispositions[dispositionKey] += 1
        recipeResults.push({
          recipeKey: candidate.recipeKey,
          disposition: row.disposition,
          replacedRecipe: row.replacedRecipe || null,
        })
      }
      productResults.push({
        productGlobalId: product.reference_code,
        productName: product.name,
        sku: product.sku,
        packClass: assignment.classKey,
        providerSellUnitProfileKey: packClass.providerSellUnitProfileKey,
        providerMappings,
        profileCount: packClass.profiles.length,
        relationshipCount: packClass.relationships.length,
        recipeCount: packClass.recipes.length,
        profileRepairs,
        relationshipResults,
        recipeResults,
      })
    }

    const assignmentHash = digest({
      scriptVersion: SCRIPT_VERSION,
      materials: AG_PACKAGING_MATERIAL_DRAFTS,
      packClasses: AG_PRODUCT_PACK_CLASSES,
      assignments,
    })
    const planFingerprint = digest({
      scriptVersion: SCRIPT_VERSION,
      assignmentHash,
      databaseFingerprint,
      organization: {
        id: target.organization.id,
        referenceCode: target.organization.reference_code,
      },
      pipelineId: target.pipeline.id,
      actorEmail: target.actorEmail,
      assignedProducts: assignments.map((assignment) => {
        const product = products.get(assignment.productGlobalId)
        return {
          id: product.id,
          globalId: product.reference_code,
          name: product.name,
          sku: product.sku,
          packClass: assignment.classKey,
          channelStates: channelStatesByProduct.get(
            assignment.productGlobalId,
          ),
        }
      }),
      cleanupPlan,
      dispositions,
      products: productResults,
    })
    if (apply) {
      assertFreshPlanFingerprint(expectedPlanFingerprint, planFingerprint)
    }
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, aggregate_type, aggregate_id, payload,
         event_key, subject, organization_id, is_system
       ) VALUES (
         $1, 'operations.pack_hierarchy.customer_drafts_staged',
         'workspace.organization', $2, $3::jsonb, $4, $5, $6::uuid, false
       )
       ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING`,
      [
        target.actorEmail,
        target.organization.reference_code,
        JSON.stringify({
          scriptVersion: SCRIPT_VERSION,
          assignmentHash,
          planFingerprint,
          materialCodes: AG_PACKAGING_MATERIAL_DRAFTS.map(
            (material) => material.code,
          ),
          productGlobalIds: assignments.map(
            (assignment) => assignment.productGlobalId,
          ),
          dispositions,
          syntheticStarterCleanup: cleanup,
          providerVariantPackMappings:
            dispositions.providerMappingsCreated
            + dispositions.providerMappingsVersioned
            + dispositions.providerMappingsReused,
          legacyProfileVersionsSuperseded: dispositions.profilesVersioned,
          legacyRelationshipsRetired: dispositions.relationshipsVersioned,
          legacyRecipesRetired: dispositions.recipesVersioned,
          activationState: 'draft_only',
          externalWrites: {
            provider: 0,
            inventory: 0,
            shipment: 0,
          },
          omittedFacts: [
            'envelope_depth',
            'tare_weight',
            'maximum_weight',
            'unit_cost',
            'warehouse_stock',
            'gross_shipping_weight',
            'intact_case_inventory',
          ],
        }),
        `operations:ag-pack-hierarchy:${planFingerprint}:v4`,
        TARGET_ORGANIZATION_NAME,
        target.organization.id,
      ],
    )

    if (apply) await client.query('COMMIT')
    else await client.query('ROLLBACK')
    return {
      applied: apply,
      assignmentHash,
      planFingerprint,
      syntheticStarterCleanup: cleanup,
      dispositions,
      products: productResults,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export async function run({
  apply = false,
  assignments = parseAssignments(assignmentInput()),
  actorEmail = actorInput(),
  expectedPlanFingerprint = expectedPlanFingerprintInput(),
  pool = null,
} = {}) {
  validatePackClassManifest()
  requireTrustedDevelopmentEnvironment()
  const databaseUrl = environmentValue('DATABASE_PUBLIC_URL')
    || environmentValue('DATABASE_URL')
  if (!databaseUrl) fail('DATABASE_PUBLIC_URL or DATABASE_URL is required')
  const normalizedDatabaseUrl = new URL(databaseUrl)
  normalizedDatabaseUrl.searchParams.delete('sslmode')
  const ownedPool = pool || new Pool({
    connectionString: normalizedDatabaseUrl.toString(),
    ssl: normalizedDatabaseUrl.hostname.endsWith('rlwy.net')
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  })
  const client = await ownedPool.connect()
  try {
    const database = await loadDatabaseIdentity(client)
    const explicitActorEmail = assignments
      ? assertExplicitActor(actorEmail)
      : ''
    const target = await loadTarget(client, explicitActorEmail)
    if (!assignments) {
      return {
        ok: true,
        scriptVersion: SCRIPT_VERSION,
        mode: 'assignment-discovery',
        database: {
          fingerprint: database.database_fingerprint,
          trustedDevelopmentDatabase: true,
        },
        organization: {
          name: target.organization.name,
          referenceCode: target.organization.reference_code,
        },
        instructions: {
          applyBlocked: true,
          reason:
            'Exact Product Global ID assignments are required; title and SKU suggestions are never applied automatically.',
          assignmentClasses: Object.keys(AG_PRODUCT_PACK_CLASSES),
          input:
            '--assignments=/absolute/path/ag-pack-assignments.json or AG_ALCHEMY_PACK_ASSIGNMENTS_JSON',
          actor:
            '--actor=active-admin@example.com or AG_ALCHEMY_PACK_ACTOR_EMAIL',
          apply:
            '--apply --plan-fingerprint=<exact fingerprint from the current plan>',
        },
        suggestions: await productSuggestions(client, target),
        materialDrafts: AG_PACKAGING_MATERIAL_DRAFTS,
      }
    }
    if (apply && assignments.length === 0) {
      fail('Apply requires at least one exact Product Global ID assignment')
    }
    const result = await stageHierarchy(
      client,
      target,
      assignments,
      apply,
      {
        databaseFingerprint: database.database_fingerprint,
        expectedPlanFingerprint,
      },
    )
    return {
      ok: true,
      scriptVersion: SCRIPT_VERSION,
      mode: apply ? 'apply' : 'plan',
      database: {
        fingerprint: database.database_fingerprint,
        trustedDevelopmentDatabase: true,
      },
      organization: {
        name: target.organization.name,
        referenceCode: target.organization.reference_code,
      },
      safety: {
        materialsRemainDraft: true,
        profilesRemainNonActive: true,
        relationshipsRemainNonActive: true,
        recipesRemainNonActive: true,
        providerMappingsUseCurrentChannelEvidence: true,
        legacyRecipeOnlyRepairIsVersioned: true,
        inventoryNotInferred: true,
        missingFactsNotInvented: true,
        providerWrites: 0,
        inventoryWrites: 0,
        shipmentWrites: 0,
      },
      ...result,
    }
  } finally {
    client.release()
    if (!pool) await ownedPool.end()
  }
}

function selfTest() {
  assert.equal(validatePackClassManifest(), true)
  assert.equal(AG_PACKAGING_MATERIAL_DRAFTS.length, 4)
  assert.deepEqual(
    AG_PACKAGING_MATERIAL_DRAFTS.map((material) => material.status),
    ['draft', 'draft', 'draft', 'draft'],
  )
  const envelope = AG_PACKAGING_MATERIAL_DRAFTS.find(
    (material) => material.code === 'AG-ENVELOPE-09X12',
  )
  assert.equal(envelope.lengthMm, 305)
  assert.equal(envelope.widthMm, 229)
  assert.equal(envelope.heightMm, null)
  assert.equal(envelope.tareWeightGrams, null)
  assert.equal(envelope.unitCostMinor, null)
  assert.equal(AG_SYNTHETIC_STARTER_MATERIALS.length, 6)
  const starter = AG_SYNTHETIC_STARTER_MATERIALS[0]
  assert.equal(starterMaterialRowMatches({
    code: starter.code,
    name: starter.name,
    material_type: starter.materialType,
    inner_length_mm: starter.lengthMm,
    inner_width_mm: starter.widthMm,
    inner_height_mm: starter.heightMm,
    dimension_basis: 'inner',
    dimension_evidence_type: 'legacy',
    dimension_evidence_reference: STARTER_EVIDENCE_REFERENCE,
    tare_weight_grams: starter.tareWeightGrams,
    max_weight_grams: starter.maxWeightGrams,
    unit_cost_minor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  }, starter), true)
  assert.equal(starterMaterialRowMatches({
    code: starter.code,
    name: starter.name,
    material_type: starter.materialType,
    inner_length_mm: starter.lengthMm,
    inner_width_mm: starter.widthMm,
    inner_height_mm: starter.heightMm,
    dimension_basis: 'inner',
    dimension_evidence_type: 'legacy',
    dimension_evidence_reference: null,
    tare_weight_grams: starter.tareWeightGrams,
    max_weight_grams: starter.maxWeightGrams,
    unit_cost_minor: null,
    currency: null,
    status: 'draft',
    source: 'starter_assortment',
  }, starter), true)
  const sixOunce = AG_PRODUCT_PACK_CLASSES.six_ounce_bag
  assert.deepEqual(
    sixOunce.relationships.map((candidate) => candidate.containedQuantity),
    [18, 30],
  )
  assert.deepEqual(
    sixOunce.recipes.map((candidate) => [
      candidate.inputQuantity,
      candidate.minimumInputQuantity,
      candidate.recipeType,
      candidate.assemblyPolicy,
      candidate.contentCompatibilityKey,
      candidate.allowsMixedProducts,
      candidate.exclusiveContents,
    ]),
    [
      [
        18,
        12,
        'max_capacity',
        'allowed',
        LOOSE_SIX_OUNCE_COMPATIBILITY_KEY,
        true,
        false,
      ],
      [
        30,
        null,
        'max_capacity',
        'allowed',
        LOOSE_SIX_OUNCE_COMPATIBILITY_KEY,
        true,
        false,
      ],
    ],
  )
  assert.equal(
    sixOunce.profiles.find((candidate) => candidate.isDefault).fitModel,
    'approved_recipe_only',
  )
  const sixOunceCase = AG_PRODUCT_PACK_CLASSES.six_ounce_case_12
  assert.equal(sixOunceCase.recipes.length, 0)
  assert.equal(sixOunceCase.relationships[0].containedQuantity, 12)
  assert.equal(
    sixOunceCase.profiles.find((candidate) => candidate.isDefault)
      .assemblyPolicy,
    'never',
  )
  const twoOunce = AG_PRODUCT_PACK_CLASSES.two_ounce_bag
  assert.deepEqual(
    twoOunce.relationships.map((candidate) => candidate.containedQuantity),
    [36],
  )
  assert.equal(twoOunce.recipes.length, 0)
  assert.equal(
    twoOunce.profiles.find(
      (candidate) => candidate.profileKey === 'customer-each',
    ).lengthMm,
    140,
  )
  const displayCarton = AG_PRODUCT_PACK_CLASSES.two_ounce_display_carton
  assert.deepEqual(
    displayCarton.relationships.map(
      (candidate) => candidate.containedQuantity,
    ),
    [6, 6],
  )
  assert.equal(displayCarton.recipes.length, 1)
  assert.equal(
    displayCarton.profiles.find((candidate) => candidate.isDefault)
      .profileKey,
    'customer-display-carton-6',
  )
  assert.equal(
    displayCarton.profiles.find(
      (candidate) => candidate.profileKey === 'customer-display-carton-6',
    ).assemblyPolicy,
    'never',
  )
  for (const classKey of ['ten_pound_bulk', 'twenty_pound_bulk']) {
    const providerSellUnit = AG_PRODUCT_PACK_CLASSES[classKey].profiles.find(
      (candidate) => candidate.isDefault,
    )
    assert.equal(providerSellUnit.fitModel, 'approved_recipe_only')
    assert.equal(providerSellUnit.lengthMm, null)
    assert.equal(providerSellUnit.widthMm, null)
    assert.equal(providerSellUnit.heightMm, null)
  }
  const bulkSellUnit = AG_PRODUCT_PACK_CLASSES.ten_pound_bulk.profiles.find(
    (candidate) => candidate.isDefault,
  )
  const legacyBulkVersion = {
    version_number: 1,
    row_version: '0',
    is_current: true,
    lifecycle_state: 'customer_confirmed',
    base_each_quantity: 1,
    unit_of_measure: 'each',
    length_mm: null,
    width_mm: null,
    height_mm: null,
    dimension_basis: 'unspecified',
    gross_weight_grams: null,
    weight_basis: 'unspecified',
    fit_model: 'rigid_3d',
    ships_as_own_package: false,
    assembly_policy: 'never',
    evidence_type: 'customer_confirmed',
    evidence_reference: CUSTOMER_EVIDENCE_REFERENCE,
    confirmed_at: '2026-07-28T00:00:00.000Z',
    source: 'customer_supplied',
  }
  const singleLegacyVersion = {
    versionCount: 1,
    maximumVersionNumber: 1,
  }
  assert.equal(
    legacyRecipeOnlyProfileUpgradeAllowed(
      legacyBulkVersion,
      bulkSellUnit,
      singleLegacyVersion,
    ),
    true,
  )
  assert.equal(
    legacyRecipeOnlyProfileUpgradeAllowed(
      { ...legacyBulkVersion, row_version: '1' },
      bulkSellUnit,
      singleLegacyVersion,
    ),
    false,
  )
  assert.equal(
    legacyRecipeOnlyProfileUpgradeAllowed(
      legacyBulkVersion,
      bulkSellUnit,
      { versionCount: 2, maximumVersionNumber: 2 },
    ),
    false,
  )
  assert.equal(
    legacyRecipeOnlyProfileUpgradeAllowed(
      { ...legacyBulkVersion, length_mm: 1 },
      bulkSellUnit,
      singleLegacyVersion,
    ),
    false,
  )
  const assignments = parseAssignments(JSON.stringify({
    six_ounce_bag: ['gp0000001'],
    six_ounce_case_12: ['gp0000002'],
    two_ounce_bag: ['gp0000003'],
    two_ounce_display_carton: ['gp0000004'],
    ten_pound_bulk: ['gp0000005'],
    twenty_pound_bulk: ['gp0000006'],
  }))
  assert.equal(assignments.length, 6)
  assert.throws(() => parseAssignments(JSON.stringify({
    six_ounce_bag: ['gp0000001'],
    two_ounce_bag: ['gp0000001'],
  })), /more than one pack class/)
  assert.equal(
    suggestedPackClass({ name: 'Apple Crisp Kringle 6oz', sku: null }),
    'six_ounce_bag',
  )
  assert.equal(
    suggestedPackClass({ name: 'Apple Crisp 6 oz 12pk', sku: null }),
    'six_ounce_case_12',
  )
  assert.equal(
    suggestedPackClass({ name: 'Apple Crisp 6oz case of 12', sku: null }),
    'six_ounce_case_12',
  )
  assert.equal(
    suggestedPackClass({ name: 'Apple Crisp 2oz Carton', sku: null }),
    'two_ounce_display_carton',
  )
  assert.equal(
    suggestedPackClass({ name: 'Apple Horse Treats 20lb', sku: null }),
    'twenty_pound_bulk',
  )
  assert.equal(
    suggestedPackClass({ name: 'Unclassified product', sku: null }),
    null,
  )
  const trustedEnvironment = {
    RAILWAY_PROJECT_ID: TRUSTED_RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: TRUSTED_RAILWAY_DEVELOPMENT_ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT_NAME: 'development',
  }
  assert.equal(assertTrustedDevelopmentEnvironment(trustedEnvironment), true)
  assert.throws(
    () => assertTrustedDevelopmentEnvironment({
      ...trustedEnvironment,
      RAILWAY_ENVIRONMENT_NAME: 'production',
    }),
    /trusted ClawPilot development environment/,
  )
  assert.equal(assertTrustedDatabaseIdentity({
    database_fingerprint: TRUSTED_DEVELOPMENT_DATABASE_FINGERPRINT,
  }), true)
  assert.throws(
    () => assertTrustedDatabaseIdentity({
      database_fingerprint: '00000000-0000-4000-8000-000000000000',
    }),
    /trusted ClawPilot development database/,
  )
  const currentPlanFingerprint = 'a'.repeat(64)
  assert.equal(
    assertFreshPlanFingerprint(
      currentPlanFingerprint,
      currentPlanFingerprint,
    ),
    true,
  )
  assert.throws(
    () => assertFreshPlanFingerprint('b'.repeat(64), currentPlanFingerprint),
    /exact current plan fingerprint/,
  )
  assert.equal(
    assertExplicitActor(' ADMIN@EXAMPLE.COM '),
    'admin@example.com',
  )
  assert.throws(() => assertExplicitActor(''), /explicit active/)
  const materialRow = {
    inner_length_mm: 279,
    inner_width_mm: 229,
    inner_height_mm: 178,
    dimension_evidence_type: 'customer_confirmed',
    dimension_evidence_reference: CUSTOMER_EVIDENCE_REFERENCE,
    dimension_confirmed_at: '2026-07-28T00:00:00.000Z',
    dimension_confirmed_by: 'admin@example.com',
  }
  assert.equal(
    materialEvidencePatchRequired(
      materialRow,
      AG_PACKAGING_MATERIAL_DRAFTS[0],
    ),
    false,
  )
  assert.equal(
    materialEvidencePatchRequired(
      { ...materialRow, dimension_confirmed_by: null },
      AG_PACKAGING_MATERIAL_DRAFTS[0],
    ),
    true,
  )
  const mappingExpected = {
    productId: '00000000-0000-4000-8000-000000000001',
    profileVersionId: '00000000-0000-4000-8000-000000000002',
    channelState: {
      external_product_id: 'provider-product',
      normalized_status: 'active',
      source_revision: 'revision-1',
      source_hash: 'c'.repeat(64),
      provider_updated_at: '2026-07-28 00:00:00+00',
    },
  }
  const mappingRow = {
    product_id: mappingExpected.productId,
    default_pack_profile_version_id: mappingExpected.profileVersionId,
    external_product_id: mappingExpected.channelState.external_product_id,
    provider_lifecycle_state: 'active',
    projection_state: 'current',
    source_revision: mappingExpected.channelState.source_revision,
    source_hash: mappingExpected.channelState.source_hash,
    provider_updated_at: mappingExpected.channelState.provider_updated_at,
  }
  assert.equal(providerPackMappingMatches(mappingRow, mappingExpected), true)
  assert.equal(providerPackMappingMatches({
    ...mappingRow,
    source_hash: 'd'.repeat(64),
  }, mappingExpected), false)
  return {
    ok: true,
    scriptVersion: SCRIPT_VERSION,
    materialDraftCount: AG_PACKAGING_MATERIAL_DRAFTS.length,
    packClasses: Object.keys(AG_PRODUCT_PACK_CLASSES),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) {
    console.log(JSON.stringify(selfTest(), null, 2))
  } else {
    const apply = process.argv.includes('--apply')
    const result = await run({ apply })
    console.log(JSON.stringify(result, null, 2))
  }
}
