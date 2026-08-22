import assert from 'node:assert/strict'
import test from 'node:test'
import {
  carrierSenderOriginMatches,
} from '../../lib/integrations/carrierOriginBinding.ts'

const warehouse = {
  line1: '6949 S 108th St',
  line2: null,
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  country: 'US',
}

const registeredCarrierAddress = {
  line1: '6949 S 108th St',
  line2: null,
  city: 'La Vista',
  region: 'NE',
  postalCode: '68128',
  countryCode: 'US',
}

test('retains an explicit matching warehouse binding as authoritative', () => {
  assert.equal(carrierSenderOriginMatches({
    senderOriginWarehouseGlobalId: 'gwh0000001',
    warehouseGlobalId: 'gwh0000001',
    warehouseAddress: {},
    registeredCarrierAddress: {},
  }), true)
})

test('rejects an explicit warehouse binding mismatch even when addresses match', () => {
  assert.equal(carrierSenderOriginMatches({
    senderOriginWarehouseGlobalId: 'gwh0000002',
    warehouseGlobalId: 'gwh0000001',
    warehouseAddress: warehouse,
    registeredCarrierAddress,
  }), false)
})

test('accepts an unbound customer-managed account with the exact warehouse address', () => {
  assert.equal(carrierSenderOriginMatches({
    senderOriginWarehouseGlobalId: null,
    warehouseGlobalId: 'gwh0000001',
    warehouseAddress: {
      ...warehouse,
      line1: '  6949  S 108th St ',
      postalCode: '68128-0000',
    },
    registeredCarrierAddress: {
      ...registeredCarrierAddress,
      line1: '6949 s 108TH st',
      postalCode: '681280000',
    },
  }), true)
})

test('rejects an unbound account when any required address fact differs', () => {
  assert.equal(carrierSenderOriginMatches({
    senderOriginWarehouseGlobalId: null,
    warehouseGlobalId: 'gwh0000001',
    warehouseAddress: warehouse,
    registeredCarrierAddress: {
      ...registeredCarrierAddress,
      postalCode: '68127',
    },
  }), false)
})

test('fails closed when an unbound warehouse address is incomplete', () => {
  assert.equal(carrierSenderOriginMatches({
    senderOriginWarehouseGlobalId: null,
    warehouseGlobalId: 'gwh0000001',
    warehouseAddress: { city: 'La Vista' },
    registeredCarrierAddress,
  }), false)
})
