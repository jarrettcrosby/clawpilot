import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveCommerceRuntimePack,
  type CommerceRuntimePackMapping,
} from '../../lib/integrations/commercePackRuntime.ts'

function mapping(
  changes: Partial<CommerceRuntimePackMapping> = {},
): CommerceRuntimePackMapping {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    globalId: 'gcvm0000001',
    rowVersion: 2,
    productId: '00000000-0000-4000-8000-000000000002',
    productMappingId: '00000000-0000-4000-8000-000000000003',
    externalProductId: 'provider-product-1',
    externalVariantId: 'provider-variant-1',
    projectionState: 'current',
    isCurrent: true,
    sourceRevision: 'provider-revision-1',
    sourceHash: 'a'.repeat(64),
    packEvidenceHash: 'c'.repeat(64),
    profileVersionId: '00000000-0000-4000-8000-000000000004',
    profileVersionGlobalId: 'gppv0000001',
    profileVersionRowVersion: 0,
    profileVersionIsCurrent: true,
    profileLifecycleState: 'customer_confirmed',
    profileStatus: 'draft',
    fitModel: 'rigid_3d',
    packageLevel: 'case',
    baseEachQuantity: 12,
    lengthMm: 279,
    widthMm: 229,
    heightMm: 178,
    dimensionBasis: 'outer',
    grossWeightGrams: null,
    weightBasis: 'unspecified',
    evidenceType: 'customer_confirmed',
    channelSourceRevision: 'provider-revision-1',
    channelSourceHash: 'a'.repeat(64),
    channelPackEvidenceHash: 'c'.repeat(64),
    channelWeightGrams: 2_400,
    ...changes,
  }
}

test('resolves customer-confirmed outer dimensions with exact-source catalog weight', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping(),
    providerUnitMultiplier: 12,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'resolved')
  assert.equal(resolved.association?.packageLevel, 'case')
  assert.equal(resolved.association?.baseEachQuantity, 12)
  assert.equal(resolved.packaging?.weightSource, 'provider_catalog')
  assert.deepEqual(resolved.packaging?.dimensionsMm, {
    length: 279,
    width: 229,
    height: 178,
  })
})

test('prefers an explicit pack-version gross weight over provider evidence', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({
      grossWeightGrams: 2_500,
      weightBasis: 'customer_stated',
    }),
    providerUnitMultiplier: 12,
    providerPackaging: {
      weightGrams: 2_450,
      dimensionsMm: {
        length: 279,
        width: 229,
        height: 178,
      },
    },
  })
  assert.equal(resolved.reason, 'resolved')
  assert.equal(resolved.packaging?.weightSource, 'profile_version')
  assert.equal(resolved.packaging?.weightGrams, 2_500)
})

test('uses exact provider-order weight when the mapped pack has no gross weight', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({ channelWeightGrams: null }),
    providerUnitMultiplier: 12,
    providerPackaging: {
      weightGrams: 2_450,
      dimensionsMm: {
        length: 279,
        width: 229,
        height: 178,
      },
    },
  })
  assert.equal(resolved.reason, 'resolved')
  assert.equal(resolved.packaging?.weightSource, 'provider_order')
  assert.equal(resolved.packaging?.weightGrams, 2_450)
})

test('preserves the mapped association but does not invent missing weight', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({ channelWeightGrams: null }),
    providerUnitMultiplier: 12,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'weight_required')
  assert.equal(resolved.association?.mappingGlobalId, 'gcvm0000001')
  assert.equal(resolved.packaging, null)
})

test('retains an exact recipe-only sell-unit association without inventing item geometry', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({
      fitModel: 'approved_recipe_only',
      packageLevel: 'each',
      baseEachQuantity: 1,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      dimensionBasis: 'unspecified',
      channelWeightGrams: 4_536,
    }),
    providerUnitMultiplier: 1,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'recipe_required')
  assert.equal(resolved.association?.mappingGlobalId, 'gcvm0000001')
  assert.equal(resolved.association?.packageLevel, 'each')
  assert.equal(resolved.packaging, null)
})

test('recipe-only association requires exact source-bound catalog weight', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({
      fitModel: 'approved_recipe_only',
      packageLevel: 'each',
      baseEachQuantity: 1,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      dimensionBasis: 'unspecified',
      grossWeightGrams: 4_536,
      weightBasis: 'provider',
      channelWeightGrams: null,
    }),
    providerUnitMultiplier: 1,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'weight_required')
  assert.equal(resolved.association?.mappingGlobalId, 'gcvm0000001')
  assert.equal(resolved.packaging, null)
})

test('non-pack catalog drift preserves physical pack readiness', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({
      channelSourceRevision: 'provider-revision-2',
      channelSourceHash: 'b'.repeat(64),
    }),
    providerUnitMultiplier: 12,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'resolved')
})

test('fails closed when pack-relevant provider evidence has changed', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({ channelPackEvidenceHash: 'd'.repeat(64) }),
    providerUnitMultiplier: 12,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'mapping_stale')
  assert.equal(resolved.association, null)
  assert.equal(resolved.packaging, null)
})

test('fails closed when a current mapping lacks a pack fingerprint', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping({ packEvidenceHash: null }),
    providerUnitMultiplier: 12,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'mapping_stale')
})

test('fails closed for non-outer or nonconfirmed pack evidence', () => {
  for (const candidate of [
    mapping({ dimensionBasis: 'inner' }),
    mapping({ profileLifecycleState: 'draft' }),
    mapping({ profileVersionIsCurrent: false }),
    mapping({ evidenceType: 'unknown' }),
    mapping({
      fitModel: 'rigid_3d',
      dimensionBasis: 'unspecified',
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    }),
  ]) {
    const resolved = resolveCommerceRuntimePack({
      mapping: candidate,
      providerUnitMultiplier: 12,
      providerPackaging: null,
    })
    assert.equal(resolved.reason, 'pack_evidence_ineligible')
    assert.equal(resolved.packaging, null)
  }
})

test('fails closed when provider case quantity conflicts with mapped base each', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping(),
    providerUnitMultiplier: 6,
    providerPackaging: null,
  })
  assert.equal(resolved.reason, 'pack_quantity_conflict')
  assert.equal(resolved.association?.baseEachQuantity, 12)
  assert.equal(resolved.packaging, null)
})

test('fails closed when provider dimensions conflict with customer pack evidence', () => {
  const resolved = resolveCommerceRuntimePack({
    mapping: mapping(),
    providerUnitMultiplier: 12,
    providerPackaging: {
      weightGrams: 2_400,
      dimensionsMm: {
        length: 280,
        width: 229,
        height: 178,
      },
    },
  })
  assert.equal(resolved.reason, 'provider_dimensions_conflict')
  assert.equal(resolved.packaging, null)
})
