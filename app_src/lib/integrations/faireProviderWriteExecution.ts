import { createHash } from 'node:crypto'
import type {
  FaireCommerceClient,
  FaireCommerceClientOptions,
  FaireProductDraftCreateInput,
  FaireProviderWriteAuthorization,
  FaireProviderWriteCapability,
  FaireProviderWriteScope,
  FaireVerifiedCredentialBinding,
} from '@/lib/integrations/faireCommerceClient'
import type {
  FaireCommerceCredential,
} from '@/lib/integrations/commerceCredentialCrypto'
import type {
  CommerceRuntimeCredentialRecord,
} from '@/lib/persistence/commerceIntegrations'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ACCOUNT_GLOBAL_ID_PATTERN = /^gia(?:[0-9]{7}|[0-9a-v]{12})$/
const AUTHORIZATION_GLOBAL_ID_PATTERN = /^gfwa(?:[0-9]{7}|[0-9a-v]{12})$/
const EFFECT_GLOBAL_ID_PATTERN = /^gcef(?:[0-9]{7}|[0-9a-v]{12})$/
const PROVIDER_ATTEMPT_GLOBAL_ID_PATTERN = /^gxa(?:[0-9]{7}|[0-9a-v]{12})$/
const SCOPE_EVIDENCE_GLOBAL_ID_PATTERN = /^gfse(?:[0-9]{7}|[0-9a-v]{12})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const SAFE_IDENTIFIER_PATTERN = /^[\x20-\x7e]+$/
const IDEMPOTENCE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'authorization',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'applicationsecret',
  'secret',
  'secretid',
  'password',
  'apikey',
  'privatekey',
  'xfaireaccesstoken',
  'xfaireoauthaccesstoken',
  'xfaireappcredentials',
])
const ALLOWED_EXECUTION_INPUT_KEYS = new Set([
  'organizationId',
  'authorizationGlobalId',
  'expectedAuthorizationFenceHash',
  'workerId',
])
// Image attachment or URL delivery requires the separate
// `product_image_upload` capability. This first one-shot action is intentionally
// limited to a text/catalog draft and cannot smuggle image authority into the
// product-create payload.
const ALLOWED_DRAFT_KEYS = new Set([
  'idempotenceToken',
  'name',
  'description',
  'shortDescription',
  'variants',
  'unitMultiplier',
  'minimumOrderQuantity',
  'allowSalesWhenOutOfStock',
  'variantOptionSets',
  'madeInCountry',
])
const ALLOWED_VARIANT_KEYS = new Set([
  'idempotenceToken',
  'name',
  'sku',
  'prices',
  'options',
  'tariffCode',
  'orderabilityType',
])
const ALLOWED_PRICE_KEYS = new Set([
  'geoConstraint',
  'wholesalePrice',
  'retailPrice',
])
const ALLOWED_MONEY_KEYS = new Set(['amountMinor', 'currency'])
const ALLOWED_GEO_KEYS = new Set(['country', 'countryGroup'])
const ALLOWED_OPTION_KEYS = new Set(['name', 'value'])
const ALLOWED_OPTION_SET_KEYS = new Set(['name', 'values'])
export const FAIRE_PROVIDER_WRITE_ACTION =
  'faire.product.draft.create' as const
export const FAIRE_PROVIDER_WRITE_OPERATION =
  'productDraftCreate' as const
export const FAIRE_PROVIDER_WRITE_ADAPTER_VERSION =
  'faire-v2-product-draft-create-v1' as const
export const FAIRE_PROVIDER_WRITE_LEASE_SECONDS = 120 as const
export const FAIRE_PROVIDER_WRITE_REQUIRED_CAPABILITIES = Object.freeze([
  'product_draft_create',
] as const satisfies readonly FaireProviderWriteCapability[])
export const FAIRE_PROVIDER_WRITE_REQUIRED_SCOPES = Object.freeze([
  'WRITE_PRODUCTS',
] as const satisfies readonly FaireProviderWriteScope[])

export type FaireProviderWriteExecutionInput = {
  organizationId: unknown
  authorizationGlobalId: unknown
  expectedAuthorizationFenceHash: unknown
  workerId: unknown
}

/**
 * This is the minimum trusted record returned by the atomic persistence claim.
 * It is deliberately separate from the execution request so callers cannot
 * submit authorization, credential, capability, or product content inline.
 */
export type ClaimedFaireProviderWrite = {
  organizationId: string
  authorizationId: string
  authorizationGlobalId: string
  authorizationRevision: number
  authorizationFenceHash: string
  scopeEvidenceGlobalId: string
  scopeEvidenceHash: string
  scopeVerificationSource: 'oauth_grant'
  verifiedWriteScopes: FaireProviderWriteScope[]
  capabilities: FaireProviderWriteCapability[]
  authorizedBy: string
  authorizedRole: 'owner' | 'admin'
  authorizedAt: string
  expiresAt: string
  consumedAt: string
  consumedBy: string
  effectId: string
  effectGlobalId: string
  integrationAccountId: string
  accountGlobalId: string
  externalAccountId: string
  credentialGeneration: number
  activationRevision: number
  action: string
  aggregateType: string
  aggregateId: string
  aggregateRevision: number
  aggregateHash: string
  idempotencyKey: string
  requestHash: string
  redactedRequest: Record<string, unknown>
  state: 'consumed'
  effectState: 'claimed'
  providerAttemptId: string
  providerAttemptGlobalId: string
  attemptNumber: 1
  leaseToken: string
  leaseExpiresAt: string
  claimedBy: string
  claimedAt: string
}

export type ResolvedFaireProviderWriteCredential = {
  runtime: CommerceRuntimeCredentialRecord
  credential: FaireCommerceCredential
}

export type FaireProviderWriteExecutionDependencies = {
  claimProviderWrite: (input: {
    organizationId: string
    authorizationGlobalId: string
    expectedAuthorizationFenceHash: string
    workerId: string
    adapterVersion: typeof FAIRE_PROVIDER_WRITE_ADAPTER_VERSION
    leaseSeconds: typeof FAIRE_PROVIDER_WRITE_LEASE_SECONDS
  }) => Promise<ClaimedFaireProviderWrite | null>
  resolveCredential: (
    claim: ClaimedFaireProviderWrite,
  ) => Promise<ResolvedFaireProviderWriteCredential>
  createClient: (
    options: FaireCommerceClientOptions,
  ) => Pick<FaireCommerceClient, 'createDraftProduct'>
  finalizeExternalEffect: (input: {
    organizationId: string
    globalId: string
    leaseToken: string
    outcome: 'succeeded' | 'failed' | 'unknown'
    redactedResult: Record<string, unknown>
    providerReference: string | null
    errorCode: string | null
    providerWriteCount: number
  }) => Promise<unknown>
  now?: () => Date
}

export type FaireProviderWriteExecutionResult = {
  effectGlobalId: string
  providerAttemptGlobalId: string
  outcome: 'succeeded' | 'failed' | 'unknown'
  providerReference: string | null
  providerWriteCount: 0 | 1
  errorCode: string | null
  replayed: false
}

export class FaireProviderWriteExecutionError extends Error {
  readonly status: number
  readonly retryable: false
  readonly effectGlobalId: string | null

  constructor(
    readonly code: string,
    message: string,
    input: { status?: number; effectGlobalId?: string | null } = {},
  ) {
    super(message)
    this.name = 'FaireProviderWriteExecutionError'
    this.status = input.status || 409
    this.retryable = false
    this.effectGlobalId = input.effectGlobalId || null
  }
}

type NormalizedExecutionInput = {
  organizationId: string
  authorizationGlobalId: string
  expectedAuthorizationFenceHash: string
  workerId: string
}

type NormalizedClaim = ClaimedFaireProviderWrite & {
  redactedRequest: {
    operation: typeof FAIRE_PROVIDER_WRITE_OPERATION
    draft: FaireProductDraftCreateInput
  }
}

function fail(
  code: string,
  message: string,
  status = 409,
  effectGlobalId?: string | null,
): never {
  throw new FaireProviderWriteExecutionError(code, message, {
    status,
    effectGlobalId,
  })
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  const constructor = prototype
    && Object.prototype.hasOwnProperty.call(prototype, 'constructor')
    ? (prototype as { constructor?: unknown }).constructor
    : null
  return prototype === null
    || (typeof constructor === 'function' && constructor.name === 'Object')
    ? value as Record<string, unknown>
    : null
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(
      'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
      `${label} contains an unsupported field`,
      400,
    )
  }
}

function identifier(value: unknown, label: string, maximum = 512) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    !normalized
    || normalized !== value
    || normalized.length > maximum
    || !SAFE_IDENTIFIER_PATTERN.test(normalized)
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      `${label} is invalid`,
      500,
    )
  }
  return Number(value)
}

function sha256(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!SHA256_PATTERN.test(normalized)) {
    fail(
      'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
      `${label} is invalid`,
      400,
    )
  }
  return normalized
}

function instant(value: unknown, label: string) {
  const normalized = identifier(value, label, 80)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      `${label} is invalid`,
      500,
    )
  }
  return new Date(timestamp).toISOString()
}

function normalizeInput(input: FaireProviderWriteExecutionInput) {
  const candidate = record(input)
  if (!candidate) {
    fail(
      'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
      'Faire provider-write execution input is invalid',
      400,
    )
  }
  exactKeys(candidate, ALLOWED_EXECUTION_INPUT_KEYS, 'Execution input')
  const organizationId = identifier(
    candidate.organizationId,
    'Organization ID',
    36,
  ).toLowerCase()
  if (!UUID_PATTERN.test(organizationId)) {
    fail(
      'FAIRE_PROVIDER_WRITE_INPUT_INVALID',
      'Organization ID is invalid',
      400,
    )
  }
  return {
    organizationId,
    authorizationGlobalId: identifier(
      candidate.authorizationGlobalId,
      'Faire authorization Global ID',
      64,
    ),
    expectedAuthorizationFenceHash: sha256(
      candidate.expectedAuthorizationFenceHash,
      'Faire authorization fence hash',
    ),
    workerId: identifier(candidate.workerId, 'Worker ID', 128),
  } satisfies NormalizedExecutionInput
}

function normalizedEvidenceKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function inspectJson(
  value: unknown,
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      'Faire claimed request contains a non-finite number',
      500,
    )
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      'Faire claimed request is not plain JSON',
      500,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) inspectJson(item, ancestors)
      return
    }
    if (!record(value)) {
      fail(
        'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
        'Faire claimed request is not plain JSON',
        500,
      )
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(normalizedEvidenceKey(key))) {
        fail(
          'FAIRE_PROVIDER_WRITE_CLAIM_NOT_REDACTED',
          'Faire claimed request contains credential material',
          500,
        )
      }
      inspectJson(child, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
        'Faire claimed request contains a non-finite number',
        500,
      )
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      'Faire claimed request is not canonical JSON',
      500,
    )
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    }
    const source = record(value)
    if (!source) {
      fail(
        'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
        'Faire claimed request is not canonical JSON',
        500,
      )
    }
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key], ancestors)}`
    )).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export function hashFaireProviderWriteEvidence(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (
    (!allowEmpty && !normalized)
    || normalized !== value
    || normalized.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      `${label} is invalid`,
      500,
    )
  }
  return normalized
}

function idempotenceToken(value: unknown, label: string) {
  const token = boundedText(value, label, 128)
  if (!IDEMPOTENCE_TOKEN_PATTERN.test(token)) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      `${label} is invalid`,
      500,
    )
  }
  return token
}

function assertMoney(value: unknown, label: string) {
  const money = record(value)
  if (!money) {
    fail('FAIRE_PROVIDER_WRITE_DRAFT_INVALID', `${label} is invalid`, 500)
  }
  exactKeys(money, ALLOWED_MONEY_KEYS, label)
  if (
    !Number.isSafeInteger(money.amountMinor)
    || Number(money.amountMinor) < 0
    || typeof money.currency !== 'string'
    || !/^[A-Z]{3}$/.test(money.currency)
  ) {
    fail('FAIRE_PROVIDER_WRITE_DRAFT_INVALID', `${label} is invalid`, 500)
  }
}

function assertDraft(value: unknown): FaireProductDraftCreateInput {
  const draft = record(value)
  if (!draft) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      'Claimed Faire product draft is invalid',
      500,
    )
  }
  exactKeys(draft, ALLOWED_DRAFT_KEYS, 'Faire product draft')
  idempotenceToken(draft.idempotenceToken, 'Faire product idempotence token')
  boundedText(draft.name, 'Faire product name', 255)
  if (draft.description !== undefined) {
    boundedText(draft.description, 'Faire product description', 65_535, true)
  }
  if (draft.shortDescription !== undefined) {
    boundedText(draft.shortDescription, 'Faire short description', 255, true)
  }
  if (
    !Number.isSafeInteger(draft.unitMultiplier)
    || Number(draft.unitMultiplier) < 1
    || !Number.isSafeInteger(draft.minimumOrderQuantity)
    || Number(draft.minimumOrderQuantity) < Number(draft.unitMultiplier)
    || Number(draft.minimumOrderQuantity) % Number(draft.unitMultiplier) !== 0
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      'Faire product order quantities are invalid',
      500,
    )
  }
  if (
    draft.allowSalesWhenOutOfStock !== undefined
    && typeof draft.allowSalesWhenOutOfStock !== 'boolean'
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      'Faire out-of-stock setting is invalid',
      500,
    )
  }
  if (draft.madeInCountry !== undefined) {
    const country = boundedText(
      draft.madeInCountry,
      'Faire country of origin',
      64,
    )
    if (country !== country.toUpperCase()) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire country of origin must already be normalized',
        500,
      )
    }
  }
  if (!Array.isArray(draft.variants) || draft.variants.length < 1
      || draft.variants.length > 250) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      'Faire product draft requires 1-250 variants',
      500,
    )
  }
  const skus = new Set<string>()
  const variantTokens = new Set<string>()
  for (const value of draft.variants) {
    const variant = record(value)
    if (!variant) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire product variant is invalid',
        500,
      )
    }
    exactKeys(variant, ALLOWED_VARIANT_KEYS, 'Faire product variant')
    const token = idempotenceToken(
      variant.idempotenceToken,
      'Faire variant idempotence token',
    )
    const sku = boundedText(variant.sku, 'Faire SKU', 128)
    boundedText(variant.name, 'Faire variant name', 255)
    if (sku.includes(',') || skus.has(sku) || variantTokens.has(token)) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire product variants require unique valid SKUs and tokens',
        500,
      )
    }
    skus.add(sku)
    variantTokens.add(token)
    if (
      variant.orderabilityType !== undefined
      && variant.orderabilityType !== 'IMMEDIATE'
    ) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire draft variants must be immediately orderable',
        500,
      )
    }
    if (!Array.isArray(variant.prices) || variant.prices.length < 1
        || variant.prices.length > 20) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire variant prices are invalid',
        500,
      )
    }
    for (const value of variant.prices) {
      const price = record(value)
      if (!price) {
        fail(
          'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
          'Faire variant price is invalid',
          500,
        )
      }
      exactKeys(price, ALLOWED_PRICE_KEYS, 'Faire variant price')
      assertMoney(price.wholesalePrice, 'Faire wholesale price')
      assertMoney(price.retailPrice, 'Faire retail price')
      if (price.geoConstraint !== undefined) {
        const geo = record(price.geoConstraint)
        if (!geo) {
          fail(
            'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
            'Faire price geographic constraint is invalid',
            500,
          )
        }
        exactKeys(geo, ALLOWED_GEO_KEYS, 'Faire price geographic constraint')
        if (geo.country === undefined && geo.countryGroup === undefined) {
          fail(
            'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
            'Faire price geographic constraint is empty',
            500,
          )
        }
        for (const [label, candidate] of [
          ['country', geo.country],
          ['country group', geo.countryGroup],
        ] as const) {
          if (candidate !== undefined) {
            const normalized = boundedText(
              candidate,
              `Faire price ${label}`,
              64,
            )
            if (normalized !== normalized.toUpperCase()) {
              fail(
                'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
                `Faire price ${label} must already be normalized`,
                500,
              )
            }
          }
        }
      }
    }
    if (variant.options !== undefined) {
      if (!Array.isArray(variant.options) || variant.options.length > 20) {
        fail(
          'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
          'Faire variant options are invalid',
          500,
        )
      }
      for (const value of variant.options) {
        const option = record(value)
        if (!option) {
          fail(
            'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
            'Faire variant option is invalid',
            500,
          )
        }
        exactKeys(option, ALLOWED_OPTION_KEYS, 'Faire variant option')
        boundedText(option.name, 'Faire variant option name', 80)
        boundedText(option.value, 'Faire variant option value', 255)
      }
    }
    if (variant.tariffCode !== undefined) {
      boundedText(variant.tariffCode, 'Faire tariff code', 32)
    }
  }
  if (draft.variantOptionSets !== undefined) {
    if (!Array.isArray(draft.variantOptionSets)
        || draft.variantOptionSets.length > 20) {
      fail(
        'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
        'Faire variant option sets are invalid',
        500,
      )
    }
    for (const value of draft.variantOptionSets) {
      const optionSet = record(value)
      if (!optionSet || !Array.isArray(optionSet.values)
          || optionSet.values.length < 1 || optionSet.values.length > 100) {
        fail(
          'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
          'Faire variant option set is invalid',
          500,
        )
      }
      exactKeys(optionSet, ALLOWED_OPTION_SET_KEYS, 'Faire variant option set')
      boundedText(optionSet.name, 'Faire variant option-set name', 80)
      for (const option of optionSet.values) {
        boundedText(option, 'Faire variant option-set value', 255)
      }
    }
  }
  const serialized = JSON.stringify(draft)
  if (Buffer.byteLength(serialized, 'utf8') > 48 * 1024) {
    fail(
      'FAIRE_PROVIDER_WRITE_DRAFT_INVALID',
      'Faire product draft exceeds the safe request size',
      500,
    )
  }
  return JSON.parse(serialized) as FaireProductDraftCreateInput
}

function exactSet<T extends string>(
  value: unknown,
  expected: readonly T[],
): value is T[] {
  return Array.isArray(value)
    && value.length === expected.length
    && expected.every((entry) => value.includes(entry))
    && new Set(value).size === value.length
}

function claimIdentity(claim: ClaimedFaireProviderWrite) {
  return {
    organizationId: identifier(claim.organizationId, 'Claim organization ID', 36)
      .toLowerCase(),
    effectGlobalId: identifier(
      claim.effectGlobalId,
      'Claim effect Global ID',
      64,
    ),
    providerAttemptGlobalId: identifier(
      claim.providerAttemptGlobalId,
      'Claim provider-attempt Global ID',
      64,
    ),
    leaseToken: identifier(claim.leaseToken, 'Claim lease token', 64),
  }
}

function normalizeClaim(
  claim: ClaimedFaireProviderWrite,
  input: NormalizedExecutionInput,
  now: Date,
): NormalizedClaim {
  const identity = claimIdentity(claim)
  if (
    !UUID_PATTERN.test(identity.organizationId)
    || identity.organizationId !== input.organizationId
    || identifier(
      claim.authorizationGlobalId,
      'Claim authorization Global ID',
      64,
    ) !== input.authorizationGlobalId
    || sha256(
      claim.authorizationFenceHash,
      'Claim authorization fence hash',
    ) !== input.expectedAuthorizationFenceHash
    || claim.action !== FAIRE_PROVIDER_WRITE_ACTION
    || claim.state !== 'consumed'
    || claim.effectState !== 'claimed'
    || claim.attemptNumber !== 1
    || identifier(claim.claimedBy, 'Claim worker ID', 128) !== input.workerId
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_MISMATCH',
      'Durable Faire provider-write claim is stale or mismatched',
      409,
      identity.effectGlobalId,
    )
  }
  if (
    positiveInteger(claim.authorizationRevision, 'Authorization revision') !== 1
    || !exactSet(
      claim.capabilities,
      FAIRE_PROVIDER_WRITE_REQUIRED_CAPABILITIES,
    )
    || !exactSet(
      claim.verifiedWriteScopes,
      FAIRE_PROVIDER_WRITE_REQUIRED_SCOPES,
    )
    || claim.scopeVerificationSource !== 'oauth_grant'
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
      'Durable Faire product-write authority is incomplete or mismatched',
      409,
      identity.effectGlobalId,
    )
  }
  positiveInteger(claim.credentialGeneration, 'Credential generation')
  positiveInteger(claim.activationRevision, 'Activation revision')
  positiveInteger(claim.aggregateRevision, 'Aggregate revision')
  if (
    !UUID_PATTERN.test(identifier(claim.authorizationId, 'Authorization ID', 36))
    || !AUTHORIZATION_GLOBAL_ID_PATTERN.test(claim.authorizationGlobalId)
    || !SCOPE_EVIDENCE_GLOBAL_ID_PATTERN.test(
      identifier(
        claim.scopeEvidenceGlobalId,
        'Scope-evidence Global ID',
        64,
      ),
    )
    || !EFFECT_GLOBAL_ID_PATTERN.test(identity.effectGlobalId)
    || !PROVIDER_ATTEMPT_GLOBAL_ID_PATTERN.test(
      identity.providerAttemptGlobalId,
    )
    || !UUID_PATTERN.test(identifier(claim.effectId, 'Effect ID', 36))
    || !UUID_PATTERN.test(
      identifier(claim.integrationAccountId, 'Integration-account ID', 36),
    )
    || !ACCOUNT_GLOBAL_ID_PATTERN.test(
      identifier(
        claim.accountGlobalId,
        'Integration-account Global ID',
        64,
      ),
    )
    || !UUID_PATTERN.test(
      identifier(claim.providerAttemptId, 'Provider-attempt ID', 36),
    )
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      'Durable Faire provider-write identities are invalid',
      500,
      identity.effectGlobalId,
    )
  }
  sha256(claim.scopeEvidenceHash, 'Scope-evidence hash')
  identifier(claim.externalAccountId, 'Faire brand ID', 128)
  identifier(claim.aggregateType, 'Aggregate type', 128)
  identifier(claim.aggregateId, 'Aggregate ID', 512)
  sha256(claim.aggregateHash, 'Aggregate hash')
  identifier(claim.idempotencyKey, 'Idempotency key', 512)
  identifier(claim.authorizedBy, 'Authorizing actor', 320)
  if (!['owner', 'admin'].includes(claim.authorizedRole)) {
    fail(
      'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
      'Durable Faire provider-write actor role is invalid',
      500,
      identity.effectGlobalId,
    )
  }
  const authorizedAt = instant(claim.authorizedAt, 'Authorized at')
  const expiresAt = instant(claim.expiresAt, 'Authorization expiry')
  const consumedAt = instant(claim.consumedAt, 'Authorization consumed at')
  if (identifier(claim.consumedBy, 'Authorization consumer', 320)
      !== claim.authorizedBy) {
    fail(
      'FAIRE_PROVIDER_WRITE_AUTHORITY_MISMATCH',
      'Durable Faire provider-write consumer is mismatched',
      500,
      identity.effectGlobalId,
    )
  }
  const claimedAt = instant(claim.claimedAt, 'Claimed at')
  const leaseExpiresAt = instant(claim.leaseExpiresAt, 'Lease expiry')
  if (
    Date.parse(authorizedAt) > Date.parse(consumedAt)
    || Date.parse(consumedAt) > Date.parse(claimedAt)
    || Date.parse(expiresAt) <= Date.parse(claimedAt)
    || Date.parse(claimedAt) > now.getTime()
    || Date.parse(leaseExpiresAt) <= now.getTime()
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_EXPIRED',
      'Durable Faire provider-write claim expired before dispatch',
      409,
      identity.effectGlobalId,
    )
  }
  inspectJson(claim.redactedRequest)
  const redactedRequest = record(claim.redactedRequest)
  if (!redactedRequest) {
    fail(
      'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      'Durable Faire provider-write request is invalid',
      500,
      identity.effectGlobalId,
    )
  }
  exactKeys(
    redactedRequest,
    new Set(['operation', 'draft']),
    'Claimed Faire request',
  )
  if (
    Object.keys(redactedRequest).length !== 2
    || redactedRequest.operation !== FAIRE_PROVIDER_WRITE_OPERATION
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_ACTION_UNSUPPORTED',
      'Only a claimed Faire draft-product creation may execute',
      409,
      identity.effectGlobalId,
    )
  }
  const requestHash = sha256(claim.requestHash, 'Claim request hash')
  if (hashFaireProviderWriteEvidence(redactedRequest) !== requestHash) {
    fail(
      'FAIRE_PROVIDER_WRITE_REQUEST_HASH_MISMATCH',
      'Claimed Faire request does not match its durable request hash',
      409,
      identity.effectGlobalId,
    )
  }
  const draft = assertDraft(redactedRequest.draft)
  return {
    ...claim,
    organizationId: identity.organizationId,
    effectGlobalId: identity.effectGlobalId,
    providerAttemptGlobalId: identity.providerAttemptGlobalId,
    leaseToken: identity.leaseToken,
    requestHash,
    claimedAt,
    leaseExpiresAt,
    redactedRequest: {
      operation: FAIRE_PROVIDER_WRITE_OPERATION,
      draft,
    },
  }
}

function assertCredential(
  claim: NormalizedClaim,
  resolved: ResolvedFaireProviderWriteCredential,
) {
  const runtime = resolved?.runtime
  const credential = resolved?.credential
  if (
    !runtime
    || runtime.organizationId !== claim.organizationId
    || runtime.integrationAccountId !== claim.integrationAccountId
    || runtime.globalId !== claim.accountGlobalId
    || runtime.provider !== 'faire'
    || runtime.environment !== 'production'
    || runtime.externalAccountId !== claim.externalAccountId
    || runtime.status !== 'active'
    || runtime.verificationStatus !== 'verified'
    || runtime.credentialVersion !== claim.credentialGeneration
    || !credential
    || credential.provider !== 'faire'
    || (
      credential.authMode === 'faire_oauth'
      && !credential.scopes.includes('WRITE_PRODUCTS')
    )
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_CREDENTIAL_STALE',
      'Verified Faire credential no longer matches the durable claim',
      409,
      claim.effectGlobalId,
    )
  }
  return { runtime, credential }
}

function clientOptions(
  claim: NormalizedClaim,
  credential: FaireCommerceCredential,
) {
  const credentialBinding: FaireVerifiedCredentialBinding = {
    provider: 'faire',
    environment: 'production',
    accountGlobalId: claim.accountGlobalId,
    externalAccountId: claim.externalAccountId,
    credentialVersion: claim.credentialGeneration,
    connectionStatus: 'active',
    verificationStatus: 'verified',
  }
  const writeAuthorization: FaireProviderWriteAuthorization = {
    provider: 'faire',
    environment: 'production',
    accountGlobalId: claim.accountGlobalId,
    externalAccountId: claim.externalAccountId,
    credentialVersion: claim.credentialGeneration,
    authorizationRevision: claim.authorizationRevision,
    capabilities: [...claim.capabilities],
    verifiedWriteScopes: [...claim.verifiedWriteScopes],
    scopeVerificationSource: claim.scopeVerificationSource,
  }
  return {
    accessToken: credential.accessToken,
    ...(credential.authMode === 'faire_oauth'
      ? {
          applicationId: credential.applicationId,
          applicationSecret: credential.applicationSecret,
        }
      : {}),
    credentialBinding,
    writeAuthorization,
  } satisfies FaireCommerceClientOptions
}

function safeErrorCode(error: unknown, fallback: string) {
  const candidate = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null
  const code = candidate ? String(candidate.code || '') : ''
  return SAFE_CODE_PATTERN.test(code) ? code : fallback
}

function explicitlyRejectedWithoutWrite(error: unknown) {
  const candidate = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : null
  if (!candidate) return false
  // The production client performs provider reads both before and after its
  // product POST. A status/error code alone therefore cannot prove that the
  // mutation was never accepted. Only an explicit stage-aware adapter signal
  // may establish a known zero-write result once dispatch has begun.
  return candidate.providerWriteAccepted === false
    && candidate.retryable !== true
}

function terminalEvidence(input: {
  claim: NormalizedClaim
  outcome: 'succeeded' | 'failed' | 'unknown'
  stage: string
  errorCode: string | null
  providerReference: string | null
  providerDispatchAttempted: boolean
  providerWritesKnown: boolean
  providerWrites: 0 | 1
}) {
  const evidence = {
    provider: 'faire',
    action: FAIRE_PROVIDER_WRITE_ACTION,
    operation: FAIRE_PROVIDER_WRITE_OPERATION,
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    providerReference: input.providerReference,
    lifecycleState: input.outcome === 'succeeded' ? 'DRAFT' : null,
    authorizationGlobalId: input.claim.authorizationGlobalId,
    scopeEvidenceGlobalId: input.claim.scopeEvidenceGlobalId,
    providerAttemptGlobalId: input.claim.providerAttemptGlobalId,
    requestSha256: input.claim.requestHash,
    providerDispatchAttempted: input.providerDispatchAttempted,
    providerWritesKnown: input.providerWritesKnown,
    providerWrites: input.providerWrites,
  }
  inspectJson(evidence)
  return evidence
}

async function finalize(input: {
  claim: NormalizedClaim
  dependencies: FaireProviderWriteExecutionDependencies
  outcome: 'succeeded' | 'failed' | 'unknown'
  stage: string
  errorCode: string | null
  providerReference: string | null
  providerDispatchAttempted: boolean
  providerWritesKnown: boolean
  providerWrites: 0 | 1
}): Promise<FaireProviderWriteExecutionResult> {
  const redactedResult = terminalEvidence(input)
  try {
    await input.dependencies.finalizeExternalEffect({
      organizationId: input.claim.organizationId,
      globalId: input.claim.effectGlobalId,
      leaseToken: input.claim.leaseToken,
      outcome: input.outcome,
      redactedResult,
      providerReference: input.providerReference,
      errorCode: input.errorCode,
      providerWriteCount: input.providerWrites,
    })
  } catch {
    fail(
      'FAIRE_PROVIDER_WRITE_FINALIZE_FAILED',
      input.providerDispatchAttempted
        ? 'Faire provider outcome requires reconciliation; do not retry the write'
        : 'Faire zero-write failure evidence could not be finalized; do not retry the write',
      500,
      input.claim.effectGlobalId,
    )
  }
  return {
    effectGlobalId: input.claim.effectGlobalId,
    providerAttemptGlobalId: input.claim.providerAttemptGlobalId,
    outcome: input.outcome,
    providerReference: input.providerReference,
    providerWriteCount: input.providerWrites,
    errorCode: input.errorCode,
    replayed: false,
  }
}

function providerProductReference(value: unknown, claim: NormalizedClaim) {
  const product = record(value)
  const id = product ? String(product.id || '').trim() : ''
  const lifecycleState = product
    ? String(product.lifecycle_state || '').trim().toUpperCase()
    : ''
  if (
    !product
    || !/^p_[A-Za-z0-9_-]+$/.test(id)
    || lifecycleState !== 'DRAFT'
    || product.name !== claim.redactedRequest.draft.name
  ) {
    fail(
      'FAIRE_PROVIDER_WRITE_READBACK_MISMATCH',
      'Faire returned a different or invalid draft product',
      502,
      claim.effectGlobalId,
    )
  }
  return id
}

async function finalizePredispatchFailure(input: {
  claim: ClaimedFaireProviderWrite
  normalizedInput: NormalizedExecutionInput
  dependencies: FaireProviderWriteExecutionDependencies
  error: unknown
  now: Date
}) {
  let claim: NormalizedClaim
  try {
    claim = normalizeClaim(input.claim, input.normalizedInput, input.now)
  } catch (claimError) {
    const identity = claimIdentity(input.claim)
    const requestHash = SHA256_PATTERN.test(input.claim.requestHash)
      ? input.claim.requestHash
      : '0'.repeat(64)
    claim = {
      ...input.claim,
      organizationId: identity.organizationId,
      effectGlobalId: identity.effectGlobalId,
      providerAttemptGlobalId: identity.providerAttemptGlobalId,
      leaseToken: identity.leaseToken,
      requestHash,
      redactedRequest: {
        operation: FAIRE_PROVIDER_WRITE_OPERATION,
        draft: {} as FaireProductDraftCreateInput,
      },
    }
    return finalize({
      claim,
      dependencies: input.dependencies,
      outcome: 'failed',
      stage: 'durable_claim_validation',
      errorCode: safeErrorCode(
        claimError,
        'FAIRE_PROVIDER_WRITE_CLAIM_INVALID',
      ),
      providerReference: null,
      providerDispatchAttempted: false,
      providerWritesKnown: true,
      providerWrites: 0,
    })
  }
  return finalize({
    claim,
    dependencies: input.dependencies,
    outcome: 'failed',
    stage: 'credential_fence',
    errorCode: safeErrorCode(
      input.error,
      'FAIRE_PROVIDER_WRITE_CREDENTIAL_FAILED',
    ),
    providerReference: null,
    providerDispatchAttempted: false,
    providerWritesKnown: true,
    providerWrites: 0,
  })
}

/**
 * Executes exactly one durable, one-shot Faire draft-product claim.
 *
 * The caller supplies only opaque persistence selectors. The product request,
 * verified scope evidence, capability, account fence, and provider-attempt
 * identity all come from the atomic claim. Credential resolution starts only
 * after that claim exists. Any ambiguous failure after the client dispatch
 * boundary is terminal `unknown`; the consumed authorization and attempt #1
 * make another dispatch impossible without a new explicit authorization.
 */
export async function executeFaireProviderWrite(
  input: FaireProviderWriteExecutionInput,
  dependencies: FaireProviderWriteExecutionDependencies,
): Promise<FaireProviderWriteExecutionResult> {
  const normalizedInput = normalizeInput(input)
  let durableClaim: ClaimedFaireProviderWrite | null
  try {
    durableClaim = await dependencies.claimProviderWrite({
      ...normalizedInput,
      adapterVersion: FAIRE_PROVIDER_WRITE_ADAPTER_VERSION,
      leaseSeconds: FAIRE_PROVIDER_WRITE_LEASE_SECONDS,
    })
  } catch (error) {
    fail(
      safeErrorCode(error, 'FAIRE_PROVIDER_WRITE_CLAIM_FAILED'),
      'Faire provider write could not acquire its durable one-shot claim',
      409,
    )
  }
  if (!durableClaim) {
    fail(
      'FAIRE_PROVIDER_WRITE_NOT_CLAIMABLE',
      'Faire provider write is already consumed, terminal, expired, or stale',
      409,
    )
  }

  let claim: NormalizedClaim
  try {
    claim = normalizeClaim(
      durableClaim,
      normalizedInput,
      (dependencies.now || (() => new Date()))(),
    )
  } catch (error) {
    return finalizePredispatchFailure({
      claim: durableClaim,
      normalizedInput,
      dependencies,
      error,
      now: (dependencies.now || (() => new Date()))(),
    })
  }

  let credential: FaireCommerceCredential
  let client: Pick<FaireCommerceClient, 'createDraftProduct'>
  try {
    const resolved = assertCredential(
      claim,
      await dependencies.resolveCredential(claim),
    )
    credential = resolved.credential
    client = dependencies.createClient(clientOptions(claim, credential))
    if (!client || typeof client.createDraftProduct !== 'function') {
      fail(
        'FAIRE_PROVIDER_WRITE_CLIENT_INVALID',
        'Faire provider-write client is unavailable',
        500,
        claim.effectGlobalId,
      )
    }
  } catch (error) {
    return finalize({
      claim,
      dependencies,
      outcome: 'failed',
      stage: 'credential_fence',
      errorCode: safeErrorCode(
        error,
        'FAIRE_PROVIDER_WRITE_CREDENTIAL_FAILED',
      ),
      providerReference: null,
      providerDispatchAttempted: false,
      providerWritesKnown: true,
      providerWrites: 0,
    })
  }

  let providerReference: string
  try {
    const result = await client.createDraftProduct(
      claim.redactedRequest.draft,
    )
    providerReference = providerProductReference(result, claim)
  } catch (error) {
    const knownZeroWrite = explicitlyRejectedWithoutWrite(error)
    const outcome = knownZeroWrite ? 'failed' : 'unknown'
    return finalize({
      claim,
      dependencies,
      outcome,
      stage: 'provider_dispatch',
      errorCode: safeErrorCode(
        error,
        knownZeroWrite
          ? 'FAIRE_PROVIDER_WRITE_REJECTED'
          : 'FAIRE_PROVIDER_WRITE_OUTCOME_UNKNOWN',
      ),
      providerReference: null,
      providerDispatchAttempted: true,
      providerWritesKnown: knownZeroWrite,
      providerWrites: 0,
    })
  }

  return finalize({
    claim,
    dependencies,
    outcome: 'succeeded',
    stage: 'provider_readback',
    errorCode: null,
    providerReference,
    providerDispatchAttempted: true,
    providerWritesKnown: true,
    providerWrites: 1,
  })
}
