#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function load(path, mocks) {
  const output = ts.transpileModule(readFileSync(resolve(path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    Uint8Array,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }, { filename: path })
  return module.exports
}

const noop = async () => null
const projection = load(
  'app_src/lib/integrations/faireProductImageProjection.ts',
  {
    '@/lib/integrations/commerceCredentialCrypto': {
      decryptCommerceCredential: noop,
    },
    '@/lib/integrations/commerceProviderImageSource': {
      readCurrentCommerceProviderImageSources: noop,
    },
    '@/lib/integrations/faireCommerceClient': {
      createFaireCommerceClient: () => ({}),
    },
    '@/lib/operations/commerceNormalization': {
      commerceProductImageLocatorFingerprint(value) {
        return createHash('sha256').update(value).digest('hex')
      },
    },
    '@/lib/persistence/commerceExternalEffects': {
      finalizeCommerceExternalEffectInPostgres: noop,
    },
    '@/lib/persistence/faireProviderWriteAuthorization': {
      claimFaireProviderWriteInPostgres: noop,
    },
    '@/lib/persistence/faireProductImageProjection': {
      prepareFaireProductImageProjectionInPostgres: noop,
      readFaireProductImageAssetForClaimInPostgres: noop,
      readFaireProductImageReconciliationContextInPostgres: noop,
      recoverExpiredFaireProductImageClaimInPostgres: noop,
      recordFaireProductImageProviderStepInPostgres: noop,
      resolveFaireProductImageAppliedReconciliationInPostgres: noop,
      resolveFaireProductImageSelectionInPostgres: noop,
    },
    '@/lib/persistence/commerceIntegrations': {
      readCommerceRuntimeCredentialFromPostgres: noop,
    },
  },
)

const ids = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  productId: '22222222-2222-4222-8222-222222222222',
  assetId: '33333333-3333-4333-8333-333333333333',
  grantId: '44444444-4444-4444-8444-444444444444',
  effectId: '55555555-5555-4555-8555-555555555555',
  accountId: '66666666-6666-4666-8666-666666666666',
  attemptId: '77777777-7777-4777-8777-777777777777',
  channelId: '88888888-8888-4888-8888-888888888888',
  pipelineId: '99999999-9999-4999-8999-999999999999',
  authId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const selection = {
  accountGlobalId: 'gia0000001',
  externalAccountId: 'b_brand123',
  externalProductId: 'p_product123',
  externalVariantId: 'po_variant123',
  productReferenceCode: 'gp0000001',
  channelStateRowVersion: 0,
  channelSourceRevision: 'faire-product-revision-4',
  channelSourceHash: hash('channel'),
  assetRevision: 2,
  assetRowVersion: 3,
  assetContentSha256: hash('asset'),
}
const command = {
  organizationId: ids.organizationId,
  productId: ids.productId,
  channelStateGlobalId: 'gpcs0000001',
  imageAssetId: ids.assetId,
  expectedProductReferenceCode: selection.productReferenceCode,
  expectedChannelStateRowVersion: selection.channelStateRowVersion,
  expectedChannelSourceRevision: selection.channelSourceRevision,
  expectedAssetRevision: selection.assetRevision,
  expectedAssetRowVersion: selection.assetRowVersion,
  expectedAssetContentSha256: selection.assetContentSha256,
  actorEmail: 'owner@example.com',
}

function grant(mode) {
  return {
    id: ids.grantId,
    organizationId: ids.organizationId,
    integrationAccountId: ids.accountId,
    pipelineId: ids.pipelineId,
    productId: ids.productId,
    channelStateId: ids.channelId,
    imageAssetId: ids.assetId,
    idempotencyKey: `faire-product-image:${hash(mode)}`,
    mode,
    accountGlobalId: selection.accountGlobalId,
    externalAccountId: selection.externalAccountId,
    externalProductId: selection.externalProductId,
    externalVariantId: selection.externalVariantId,
    productReferenceCode: selection.productReferenceCode,
    productSourceHash: hash('product'),
    channelStateGlobalId: command.channelStateGlobalId,
    channelStateRowVersion: selection.channelStateRowVersion,
    channelSourceRevision: selection.channelSourceRevision,
    channelSourceHash: selection.channelSourceHash,
    assetRevision: selection.assetRevision,
    assetRowVersion: selection.assetRowVersion,
    assetContentSha256: selection.assetContentSha256,
    assetMimeType: 'image/png',
    assetByteLength: 5,
    assetPixelWidth: 10,
    assetPixelHeight: 10,
    assetAltText: 'Exact test Product image',
    credentialGeneration: 7,
    activationRevision: 11,
    aggregateRevision: mode === 'shadow' ? 1 : 2,
    aggregateHash: hash(`aggregate-${mode}`),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    effectId: ids.effectId,
    effectGlobalId: 'gcef0000001',
    effectState: mode === 'shadow' ? 'simulated' : 'pending',
    effectResult: mode === 'shadow' ? {
      provider: 'faire',
      operation: 'productImagePublish',
      outcome: 'simulated',
      providerWrites: 0,
    } : null,
    leaseExpired: false,
    providerWriteCount: 0,
    replayed: false,
    authorization: mode === 'active' ? {
      globalId: 'gfwa0000001',
      fenceHash: hash('fence'),
      shadowSimulationEffectGlobalId: 'gcef0000002',
    } : null,
  }
}

function claim(activeGrant) {
  return {
    organizationId: activeGrant.organizationId,
    authorizationId: ids.authId,
    authorizationGlobalId: activeGrant.authorization.globalId,
    authorizationRevision: 1,
    authorizationFenceHash: activeGrant.authorization.fenceHash,
    scopeEvidenceGlobalId: 'gfse0000001',
    scopeEvidenceHash: hash('scope'),
    scopeVerificationSource: 'oauth_grant',
    verifiedWriteScopes: ['WRITE_PRODUCTS'],
    capabilities: ['product_draft_update', 'product_image_upload'],
    authorizedBy: command.actorEmail,
    authorizedRole: 'owner',
    authorizedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    consumedAt: new Date().toISOString(),
    consumedBy: command.actorEmail,
    effectId: activeGrant.effectId,
    effectGlobalId: activeGrant.effectGlobalId,
    integrationAccountId: activeGrant.integrationAccountId,
    accountGlobalId: activeGrant.accountGlobalId,
    externalAccountId: activeGrant.externalAccountId,
    credentialGeneration: activeGrant.credentialGeneration,
    activationRevision: activeGrant.activationRevision,
    action: 'faire.product.image.publish',
    aggregateType: 'crm.product',
    aggregateId: activeGrant.productReferenceCode,
    aggregateRevision: activeGrant.aggregateRevision,
    aggregateHash: activeGrant.aggregateHash,
    idempotencyKey: activeGrant.idempotencyKey,
    requestHash: hash('request'),
    redactedRequest: {},
    state: 'consumed',
    effectState: 'claimed',
    providerAttemptId: ids.attemptId,
    providerAttemptGlobalId: 'gxa0000001',
    attemptNumber: 1,
    leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
    claimedBy: 'faire-product-image-publish',
    claimedAt: new Date().toISOString(),
    productImageDeliveryGrantId: activeGrant.id,
    shadowSimulationEffectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  }
}

let forbiddenShadowCall = false
const shadowResult = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: false,
  shadowSimulationEffectGlobalId: null,
}, {
  resolveSelection: async () => selection,
  prepareProjection: async () => grant('shadow'),
  claimProviderWrite: async () => {
    forbiddenShadowCall = true
  },
  readAsset: async () => {
    forbiddenShadowCall = true
  },
  readRuntimeCredential: async () => {
    forbiddenShadowCall = true
  },
  decryptCredential: () => {
    forbiddenShadowCall = true
  },
  readProviderImages: async () => {
    forbiddenShadowCall = true
  },
  createClient: () => {
    forbiddenShadowCall = true
  },
  recordProviderStep: async () => {
    forbiddenShadowCall = true
  },
  finalizeEffect: async () => {
    forbiddenShadowCall = true
  },
})
assert.equal(forbiddenShadowCall, false)
assert.equal(shadowResult.mode, 'shadow')
assert.equal(shadowResult.providerMutation.writeCount, 0)

function activeDependencies({
  uploadError = null,
  attachError = null,
  uploadEvidenceError = null,
} = {}) {
  const activeGrant = grant('active')
  const steps = []
  const finalizations = []
  const patches = []
  const uploadedUrl = 'https://cdn.faire.com/uploaded-fixture.png'
  const dependencies = {
    resolveSelection: async () => selection,
    prepareProjection: async () => activeGrant,
    claimProviderWrite: async () => claim(activeGrant),
    recoverExpiredClaim: async () => {
      throw new Error('a fresh pending claim must not recover')
    },
    readAsset: async () => ({
      bytes: new Uint8Array(Buffer.from('image')),
      mimeType: 'image/png',
      contentSha256: selection.assetContentSha256,
      byteLength: 5,
    }),
    readRuntimeCredential: async () => ({
      organizationId: ids.organizationId,
      integrationAccountId: ids.accountId,
      globalId: selection.accountGlobalId,
      provider: 'faire',
      environment: 'production',
      externalAccountId: selection.externalAccountId,
      status: 'active',
      verificationStatus: 'verified',
      credentialVersion: 7,
      authMode: 'faire_oauth',
      configuration: {},
      encrypted: {},
    }),
    decryptCredential: () => ({
      provider: 'faire',
      authMode: 'faire_oauth',
      accessToken: 'secret-token',
      applicationId: 'secret-app',
      applicationSecret: 'secret-app-value',
      scopes: ['READ_PRODUCTS', 'WRITE_PRODUCTS'],
    }),
    readProviderImages: async (input) => {
      assert.equal(input.requireExactOrderedSet, true)
      return [{
        providerImageId: 'fi_existing',
        locatorSha256: hash('existing-url'),
        sequence: 0,
        url: 'https://cdn.faire.com/existing-fixture.png',
      }, {
        providerImageId: 'fi_existing_duplicate',
        locatorSha256: hash('existing-url'),
        sequence: 1,
        url: 'https://cdn.faire.com/existing-fixture.png',
      }]
    },
    createClient: (options) => {
      assert.deepEqual([...options.writeAuthorization.capabilities], [
        'product_draft_update',
        'product_image_upload',
      ])
      return {
        async uploadProductImage() {
          if (uploadError) throw uploadError
          return { url: uploadedUrl }
        },
        async updateProductImages(productId, patch) {
          patches.push({ productId, patch })
          if (attachError) throw attachError
          return { id: productId, lifecycle_state: 'PUBLISHED' }
        },
      }
    },
    recordProviderStep: async (step) => {
      if (step.stage === 'upload' && uploadEvidenceError) {
        throw uploadEvidenceError
      }
      assert.equal(JSON.stringify(step.redactedEvidence).includes('https://'), false)
      assert.equal(JSON.stringify(step.redactedEvidence).includes('secret'), false)
      steps.push(step)
      return { id: ids.attemptId, observedAt: new Date().toISOString() }
    },
    finalizeEffect: async (value) => {
      finalizations.push(value)
      return value
    },
  }
  return { activeGrant, dependencies, steps, finalizations, patches, uploadedUrl }
}

const success = activeDependencies()
const successResult = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: true,
  shadowSimulationEffectGlobalId: 'gcef0000002',
}, success.dependencies)
assert.equal(successResult.externalEffect.state, 'succeeded')
assert.equal(successResult.providerMutation.writeCount, 2)
assert.equal(success.steps.length, 2)
assert.deepEqual(success.steps.map((step) => step.stage), ['upload', 'attach'])
assert.equal(
  success.steps[1].redactedEvidence.assetContentSha256,
  selection.assetContentSha256,
)
assert.equal(success.steps[1].redactedEvidence.providerWritesKnown, true)
assert.equal(success.steps[1].redactedEvidence.providerWriteCountLowerBound, 2)
assert.equal(success.finalizations[0].providerWriteCount, 2)
assert.equal(success.patches[0].productId, selection.externalProductId)
assert.deepEqual(
  JSON.parse(JSON.stringify(
    success.patches[0].patch.images.map((image) => image.sequence),
  )),
  [0, 1, 2],
)
assert.equal(success.patches[0].patch.images[0].url.includes('existing'), true)
assert.equal(success.patches[0].patch.images[1].url.includes('existing'), true)
assert.equal(success.patches[0].patch.images[2].url, success.uploadedUrl)
assert.deepEqual(
  JSON.parse(JSON.stringify(success.patches[0].patch.expectedCurrentImages)),
  [{
    url: 'https://cdn.faire.com/existing-fixture.png',
    sequence: 0,
  }, {
    url: 'https://cdn.faire.com/existing-fixture.png',
    sequence: 1,
  }],
)

const terminalReplayGrant = {
  ...success.activeGrant,
  effectState: 'succeeded',
  effectResult: success.finalizations[0].redactedResult,
  providerWriteCount: 2,
  replayed: true,
}
let terminalReplayProviderCalls = 0
const terminalReplay = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: true,
  shadowSimulationEffectGlobalId: 'gcef0000002',
}, {
  resolveSelection: async () => selection,
  prepareProjection: async () => terminalReplayGrant,
  claimProviderWrite: async () => {
    terminalReplayProviderCalls += 1
  },
  recoverExpiredClaim: async () => {
    terminalReplayProviderCalls += 1
  },
  readAsset: async () => {
    terminalReplayProviderCalls += 1
  },
  readRuntimeCredential: async () => {
    terminalReplayProviderCalls += 1
  },
  readProviderImages: async () => {
    terminalReplayProviderCalls += 1
  },
  createClient: () => {
    terminalReplayProviderCalls += 1
    return {}
  },
  recordProviderStep: async () => {
    terminalReplayProviderCalls += 1
  },
  finalizeEffect: async () => {
    terminalReplayProviderCalls += 1
  },
})
assert.equal(terminalReplay.replayed, true)
assert.equal(terminalReplay.externalEffect.state, 'succeeded')
assert.equal(terminalReplay.externalEffect.globalId, 'gcef0000001')
assert.equal(terminalReplayProviderCalls, 0)

const liveClaimGrant = {
  ...success.activeGrant,
  effectState: 'claimed',
  leaseExpired: false,
  replayed: true,
}
await assert.rejects(
  projection.executeFaireProductImagePublish({
    ...command,
    executeProviderWrite: true,
    shadowSimulationEffectGlobalId: 'gcef0000002',
  }, {
    resolveSelection: async () => selection,
    prepareProjection: async () => liveClaimGrant,
    claimProviderWrite: async () => {
      throw new Error('live claimed replay must not reclaim')
    },
  }),
  (error) => error?.code === 'FAIRE_PRODUCT_IMAGE_RECONCILIATION_REQUIRED'
    && error?.externalEffectGlobalId === 'gcef0000001',
)

let expiredRecoveryCalls = 0
const expiredClaimReplay = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: true,
  shadowSimulationEffectGlobalId: 'gcef0000002',
}, {
  resolveSelection: async () => selection,
  prepareProjection: async () => ({
    ...liveClaimGrant,
    leaseExpired: true,
  }),
  claimProviderWrite: async () => {
    throw new Error('expired claimed replay must not reclaim')
  },
  recoverExpiredClaim: async () => {
    expiredRecoveryCalls += 1
    return {
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 1,
      uploadedLocatorSha256: hash('recovered-upload'),
      priorImageCount: 2,
      projectedImageCount: 3,
      reconciliationEligibility: 'readback_terminalizable',
      reconciliationReason: 'exact_attach_unknown_evidence',
      latestOutcome: 'succeeded',
      latestObservedAt: new Date().toISOString(),
    }
  },
})
assert.equal(expiredRecoveryCalls, 1)
assert.equal(expiredClaimReplay.replayed, true)
assert.equal(expiredClaimReplay.externalEffect.state, 'unknown')
assert.equal(expiredClaimReplay.providerMutation.writeCount, 1)
assert.equal(expiredClaimReplay.images.existingPreserved, true)
assert.equal(expiredClaimReplay.images.priorCount, 2)
assert.equal(expiredClaimReplay.images.projectedCount, 3)

const uploadUnknown = activeDependencies({
  uploadError: Object.assign(new Error('timeout'), {
    code: 'FAIRE_UPSTREAM_TIMEOUT',
  }),
})
const uploadUnknownResult = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: true,
  shadowSimulationEffectGlobalId: 'gcef0000002',
}, uploadUnknown.dependencies)
assert.equal(uploadUnknownResult.externalEffect.state, 'unknown')
assert.equal(uploadUnknownResult.providerMutation.writeCount, 0)
assert.equal(uploadUnknown.patches.length, 0)
assert.equal(uploadUnknown.finalizations.length, 1)

const uploadEvidenceUnknown = activeDependencies({
  uploadEvidenceError: new Error('disposable persistence outage'),
})
const uploadEvidenceUnknownResult =
  await projection.executeFaireProductImagePublish({
    ...command,
    executeProviderWrite: true,
    shadowSimulationEffectGlobalId: 'gcef0000002',
  }, uploadEvidenceUnknown.dependencies)
assert.equal(uploadEvidenceUnknownResult.externalEffect.state, 'unknown')
assert.equal(uploadEvidenceUnknownResult.providerMutation.writeCount, 1)
assert.match(
  uploadEvidenceUnknown.finalizations[0].redactedResult
    .uploadedLocatorSha256,
  /^[a-f0-9]{64}$/,
)
assert.equal(
  uploadEvidenceUnknown.finalizations[0].redactedResult.stage,
  'upload_evidence_persistence',
)
assert.equal(uploadEvidenceUnknown.patches.length, 0)

const attachUnknown = activeDependencies({
  attachError: Object.assign(new Error('invalid response'), {
    code: 'FAIRE_RESPONSE_INVALID',
  }),
})
const attachUnknownResult = await projection.executeFaireProductImagePublish({
  ...command,
  executeProviderWrite: true,
  shadowSimulationEffectGlobalId: 'gcef0000002',
}, attachUnknown.dependencies)
assert.equal(attachUnknownResult.externalEffect.state, 'unknown')
assert.equal(attachUnknownResult.providerMutation.writeCount, 1)
assert.equal(attachUnknown.steps[0].stage, 'upload')
assert.equal(attachUnknown.steps[1].outcome, 'unknown')
assert.equal(
  attachUnknown.steps[1].redactedEvidence.externalProductId,
  selection.externalProductId,
)
assert.equal(
  attachUnknown.steps[1].redactedEvidence.assetContentSha256,
  selection.assetContentSha256,
)
assert.equal(attachUnknown.steps[1].redactedEvidence.priorImageCount, 2)
assert.equal(attachUnknown.steps[1].redactedEvidence.projectedImageCount, 3)
assert.equal(attachUnknown.steps[1].redactedEvidence.existingImagesPreserved, true)
assert.equal(attachUnknown.steps[1].redactedEvidence.providerWritesKnown, false)
assert.equal(
  attachUnknown.steps[1].redactedEvidence.providerWriteCountLowerBound,
  1,
)
assert.equal(attachUnknown.finalizations.length, 1)

const locatorSha256 = hash('uploaded-locator')
const appliedResolutions = []
const reconciliation = await projection.reconcileFaireProductImagePublish({
  organizationId: ids.organizationId,
  productId: ids.productId,
  externalEffectGlobalId: 'gcef0000001',
  actorEmail: command.actorEmail,
}, {
  readContext: async () => ({
    deliveryGrantId: ids.grantId,
    productId: ids.productId,
    accountGlobalId: selection.accountGlobalId,
    credentialGeneration: 7,
    externalProductId: selection.externalProductId,
    assetContentSha256: selection.assetContentSha256,
    externalEffectId: ids.effectId,
    externalEffectGlobalId: 'gcef0000001',
    effectState: 'unknown',
    leaseExpired: false,
    providerWriteCount: 1,
    uploadedLocatorSha256: locatorSha256,
    reconciliationEligibility: 'readback_terminalizable',
    reconciliationReason: 'exact_unknown_effect_evidence',
    latestOutcome: 'unknown',
    latestObservedAt: new Date().toISOString(),
  }),
  readProviderImages: async (input) => {
    assert.equal(input.requireExactOrderedSet, true)
    return [{
      providerImageId: null,
      locatorSha256,
      sequence: 0,
      url: 'https://cdn.faire.com/transient-only.png',
    }]
  },
  recordProviderStep: async () => {
    throw new Error('exact application must use atomic terminal resolution')
  },
  resolveApplied: async (resolution) => {
    appliedResolutions.push(resolution)
    return {
      effectState: 'succeeded',
      providerImageCount: 1,
      exactLocatorMatchCount: 1,
      providerImageSetSha256: resolution.providerImageSetSha256,
      replayed: false,
    }
  },
})
assert.equal(reconciliation.confirmedApplied, true)
assert.equal(reconciliation.outcome, 'observed_applied')
assert.equal(reconciliation.terminalized, true)
assert.equal(appliedResolutions.length, 1)
assert.equal(
  JSON.stringify(appliedResolutions[0]).includes('https://'),
  false,
)

let terminalReplayReconciliationCalls = 0
const terminalReconciliationReplay =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      assetContentSha256: selection.assetContentSha256,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'succeeded',
      leaseExpired: false,
      providerWriteCount: 2,
      uploadedLocatorSha256: locatorSha256,
      latestOutcome: 'observed_applied',
      latestObservedAt: new Date().toISOString(),
      reconciliationApplied: true,
      reconciledProviderImageCount: 1,
      reconciledExactLocatorMatchCount: 1,
      reconciledProviderImageSetSha256: hash('provider-set'),
    }),
    readProviderImages: async () => {
      terminalReplayReconciliationCalls += 1
      return []
    },
    recordProviderStep: async () => {
      terminalReplayReconciliationCalls += 1
    },
    resolveApplied: async () => {
      terminalReplayReconciliationCalls += 1
    },
  })
assert.equal(terminalReconciliationReplay.outcome, 'observed_applied')
assert.equal(terminalReconciliationReplay.terminalized, true)
assert.equal(terminalReconciliationReplay.replayed, true)
assert.equal(terminalReplayReconciliationCalls, 0)

const absentSteps = []
const absentReconciliation =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      assetContentSha256: selection.assetContentSha256,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 1,
      uploadedLocatorSha256: locatorSha256,
      reconciliationEligibility: 'readback_terminalizable',
      reconciliationReason: 'exact_unknown_effect_evidence',
      latestOutcome: 'unknown',
      latestObservedAt: new Date().toISOString(),
    }),
    readProviderImages: async () => [{
      providerImageId: null,
      locatorSha256: hash('different-locator'),
      sequence: 0,
      url: 'https://cdn.faire.com/different.png',
    }],
    recordProviderStep: async (step) => {
      absentSteps.push(step)
      return { id: ids.attemptId, observedAt: new Date().toISOString() }
    },
    resolveApplied: async () => {
      throw new Error('absent locator must remain unknown')
    },
  })
assert.equal(absentReconciliation.outcome, 'observed_absent')
assert.equal(absentReconciliation.confirmedApplied, false)
assert.equal(absentReconciliation.terminalized, false)
assert.equal(absentSteps[0].outcome, 'observed_absent')

const ambiguousSteps = []
const ambiguousReconciliation =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      assetContentSha256: selection.assetContentSha256,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 1,
      uploadedLocatorSha256: locatorSha256,
      reconciliationEligibility: 'readback_terminalizable',
      reconciliationReason: 'exact_unknown_effect_evidence',
      latestOutcome: 'unknown',
      latestObservedAt: new Date().toISOString(),
    }),
    readProviderImages: async () => [0, 1].map((sequence) => ({
      providerImageId: null,
      locatorSha256,
      sequence,
      url: `https://cdn.faire.com/duplicate-${sequence}.png`,
    })),
    recordProviderStep: async (step) => {
      ambiguousSteps.push(step)
      return { id: ids.attemptId, observedAt: new Date().toISOString() }
    },
    resolveApplied: async () => {
      throw new Error('duplicate locator matches must remain unknown')
    },
  })
assert.equal(ambiguousReconciliation.outcome, 'manual_review')
assert.equal(
  ambiguousReconciliation.reason,
  'ambiguous_exact_locator_matches',
)
assert.equal(ambiguousReconciliation.terminalized, false)
assert.equal(ambiguousSteps[0].outcome, 'manual_review')

const failedConflictSteps = []
const failedConflict = await projection.reconcileFaireProductImagePublish({
  organizationId: ids.organizationId,
  productId: ids.productId,
  externalEffectGlobalId: 'gcef0000001',
  actorEmail: command.actorEmail,
}, {
  readContext: async () => ({
    deliveryGrantId: ids.grantId,
    productId: ids.productId,
    accountGlobalId: selection.accountGlobalId,
    credentialGeneration: 7,
    externalProductId: selection.externalProductId,
    assetContentSha256: selection.assetContentSha256,
    externalEffectId: ids.effectId,
    externalEffectGlobalId: 'gcef0000001',
    effectState: 'failed',
    leaseExpired: false,
    providerWriteCount: 1,
    uploadedLocatorSha256: locatorSha256,
    latestOutcome: 'failed',
    latestObservedAt: new Date().toISOString(),
  }),
  readProviderImages: async () => [{
    providerImageId: null,
    locatorSha256,
    sequence: 0,
    url: 'https://cdn.faire.com/failed-conflict.png',
  }],
  recordProviderStep: async (step) => {
    failedConflictSteps.push(step)
    return { id: ids.attemptId, observedAt: new Date().toISOString() }
  },
  resolveApplied: async () => {
    throw new Error('known failed effects must not become succeeded')
  },
})
assert.equal(failedConflict.outcome, 'manual_review')
assert.equal(failedConflict.reason, 'effect_state_conflicts_with_readback')
assert.equal(failedConflictSteps[0].outcome, 'manual_review')

let reconciliationRecoveryCalls = 0
let reconciliationProviderReads = 0
const recoveredReconciliation =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'claimed',
      leaseExpired: true,
      providerWriteCount: 0,
      uploadedLocatorSha256: null,
      latestOutcome: null,
      latestObservedAt: null,
    }),
    recoverExpiredClaim: async () => {
      reconciliationRecoveryCalls += 1
      return {
        deliveryGrantId: ids.grantId,
        productId: ids.productId,
        accountGlobalId: selection.accountGlobalId,
        credentialGeneration: 7,
        externalProductId: selection.externalProductId,
        assetContentSha256: selection.assetContentSha256,
        externalEffectId: ids.effectId,
        externalEffectGlobalId: 'gcef0000001',
        effectState: 'unknown',
        leaseExpired: false,
        providerWriteCount: 1,
        uploadedLocatorSha256: locatorSha256,
        reconciliationEligibility: 'readback_terminalizable',
        reconciliationReason: 'exact_attach_unknown_evidence',
        latestOutcome: 'succeeded',
        latestObservedAt: new Date().toISOString(),
      }
    },
    readProviderImages: async (input) => {
      assert.equal(input.requireExactOrderedSet, true)
      reconciliationProviderReads += 1
      return [{
        providerImageId: null,
        locatorSha256,
        sequence: 0,
        url: 'https://cdn.faire.com/transient-recovery.png',
      }]
    },
    recordProviderStep: async () => ({
      id: ids.attemptId,
      observedAt: new Date().toISOString(),
    }),
    resolveApplied: async (resolution) => ({
      effectState: 'succeeded',
      providerImageCount: 1,
      exactLocatorMatchCount: 1,
      providerImageSetSha256: resolution.providerImageSetSha256,
      replayed: false,
    }),
  })
assert.equal(reconciliationRecoveryCalls, 1)
assert.equal(reconciliationProviderReads, 1)
assert.equal(recoveredReconciliation.confirmedApplied, true)

let manualReviewProviderReads = 0
const recoveredManualReview =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'claimed',
      leaseExpired: true,
      providerWriteCount: 0,
      uploadedLocatorSha256: null,
      latestOutcome: null,
      latestObservedAt: null,
    }),
    recoverExpiredClaim: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 0,
      uploadedLocatorSha256: null,
      reconciliationEligibility: 'manual_review',
      reconciliationReason: 'upload_locator_unavailable',
      latestOutcome: null,
      latestObservedAt: null,
    }),
    readProviderImages: async () => {
      manualReviewProviderReads += 1
      return []
    },
    recordProviderStep: async () => ({
      id: ids.attemptId,
      observedAt: new Date().toISOString(),
    }),
  })
assert.equal(recoveredManualReview.outcome, 'manual_review')
assert.equal(manualReviewProviderReads, 0)

let ineligibleLocatorProviderReads = 0
const ineligibleLocatorSteps = []
const ineligibleLocatorReview =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      assetContentSha256: selection.assetContentSha256,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 1,
      uploadedLocatorSha256: locatorSha256,
      reconciliationEligibility: 'manual_review',
      reconciliationReason: 'exact_attachment_evidence_unavailable',
      latestOutcome: 'succeeded',
      latestObservedAt: new Date().toISOString(),
    }),
    readProviderImages: async () => {
      ineligibleLocatorProviderReads += 1
      return []
    },
    recordProviderStep: async (step) => {
      ineligibleLocatorSteps.push(step)
      return { id: ids.attemptId, observedAt: new Date().toISOString() }
    },
  })
assert.equal(ineligibleLocatorReview.outcome, 'manual_review')
assert.equal(
  ineligibleLocatorReview.reason,
  'exact_attachment_evidence_unavailable',
)
assert.equal(ineligibleLocatorProviderReads, 0)
assert.equal(ineligibleLocatorSteps[0].outcome, 'manual_review')

const malformedReadSteps = []
const malformedReadResult =
  await projection.reconcileFaireProductImagePublish({
    organizationId: ids.organizationId,
    productId: ids.productId,
    externalEffectGlobalId: 'gcef0000001',
    actorEmail: command.actorEmail,
  }, {
    readContext: async () => ({
      deliveryGrantId: ids.grantId,
      productId: ids.productId,
      accountGlobalId: selection.accountGlobalId,
      credentialGeneration: 7,
      externalProductId: selection.externalProductId,
      externalEffectId: ids.effectId,
      externalEffectGlobalId: 'gcef0000001',
      effectState: 'unknown',
      leaseExpired: false,
      providerWriteCount: 1,
      uploadedLocatorSha256: locatorSha256,
      reconciliationEligibility: 'readback_terminalizable',
      reconciliationReason: 'exact_unknown_effect_evidence',
      latestOutcome: 'unknown',
      latestObservedAt: new Date().toISOString(),
    }),
    readProviderImages: async (input) => {
      assert.equal(input.requireExactOrderedSet, true)
      throw Object.assign(new Error('malformed provider array'), {
        code: 'COMMERCE_PROVIDER_IMAGE_SOURCE_EXACT_SET_INVALID',
      })
    },
    recordProviderStep: async (step) => {
      malformedReadSteps.push(step)
      return { id: ids.attemptId, observedAt: new Date().toISOString() }
    },
  })
assert.equal(malformedReadResult.outcome, 'manual_review')
assert.equal(malformedReadResult.confirmedApplied, false)
assert.equal(malformedReadSteps[0].outcome, 'manual_review')
assert.notEqual(malformedReadResult.outcome, 'observed_absent')

console.log('Faire Product-image publication tests passed')
