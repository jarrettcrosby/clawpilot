import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the explicit extension.
import {
  changedOrderShipToFields,
  mergeOrderShipToDraft,
  normalizeOrderShipToDraft,
  orderShipToIssues,
  orderShipToReadiness,
  orderShipToStorageValue,
} from '../../lib/operations/orderShipTo.ts'

test('keeps a partial imported address editable without fabricating fields', () => {
  const imported = normalizeOrderShipToDraft({
    name: '  Vendor Receiving  ',
    city: 'Detroit',
    countryCode: 'us',
  } as Record<string, unknown>)

  assert.deepEqual(imported, {
    name: 'Vendor Receiving',
    line1: null,
    line2: null,
    city: 'Detroit',
    region: null,
    postalCode: null,
    country: 'US',
  })
  assert.equal(orderShipToReadiness(imported), 'incomplete')
  assert.deepEqual(orderShipToStorageValue(imported), {
    name: 'Vendor Receiving',
    city: 'Detroit',
    country: 'US',
  })
})

test('merges one ordinary field edit into the imported working copy', () => {
  const before = normalizeOrderShipToDraft({
    name: 'Vendor Receiving',
    line1: '100 Woodward Ave',
    city: 'Detroit',
    country: 'US',
  })
  const after = mergeOrderShipToDraft(before, {
    region: 'MI',
    postalCode: '48226',
  })

  assert.equal(after.line1, '100 Woodward Ave')
  assert.equal(after.region, 'MI')
  assert.equal(after.postalCode, '48226')
  assert.equal(orderShipToReadiness(after), 'carrier_ready')
  assert.deepEqual(changedOrderShipToFields(before, after), [
    'region',
    'postalCode',
  ])
})

test('allows a user to clear a field and reports only compact field issues', () => {
  const before = normalizeOrderShipToDraft({
    name: 'Vendor Receiving',
    line1: '100 Woodward Ave',
    line2: 'Dock 2',
    city: 'Detroit',
    region: 'MI',
    postalCode: '48226',
    country: 'US',
  })
  const after = mergeOrderShipToDraft(before, {
    line1: null,
    line2: '',
  })

  assert.equal(after.line1, null)
  assert.equal(after.line2, null)
  assert.equal(orderShipToReadiness(after), 'incomplete')
  assert.deepEqual(orderShipToIssues(after), [
    { field: 'line1', code: 'required' },
  ])
})

test('retains an invalid country as editable data instead of rejecting the draft', () => {
  const address = normalizeOrderShipToDraft({
    name: 'Vendor Receiving',
    line1: '100 Woodward Ave',
    city: 'Detroit',
    region: 'MI',
    postalCode: '48226',
    country: 'usa',
  })

  assert.equal(address.country, 'USA')
  assert.equal(orderShipToReadiness(address), 'incomplete')
  assert.deepEqual(orderShipToIssues(address), [
    { field: 'country', code: 'invalid_format' },
  ])
})

test('an empty local working copy remains a valid missing draft', () => {
  const empty = normalizeOrderShipToDraft(null)
  assert.equal(orderShipToReadiness(empty), 'missing')
  assert.deepEqual(orderShipToStorageValue(empty), {})
})

test('normalizes legacy dispatch contact and country aliases', () => {
  assert.deepEqual(normalizeOrderShipToDraft({
    contactName: 'Vendor receiving',
    line1: '10 Example Way',
    city: 'Charlotte',
    region: 'NC',
    postalCode: '28202',
    countryCode: 'us',
  }), {
    name: 'Vendor receiving',
    line1: '10 Example Way',
    line2: null,
    city: 'Charlotte',
    region: 'NC',
    postalCode: '28202',
    country: 'US',
  })
})
