import assert from 'node:assert/strict'
import test from 'node:test'
import { crmRecordNavigationPath } from '../app_src/lib/crm/recordNavigation.mjs'

const CRM_PREFIXES = ['ga', 'gc', 'gi', 'gk', 'gl', 'gm', 'go', 'gp']
const PIPELINE_ID = '00000000-0000-4000-8000-000000000100'
const APP_ORIGINS = [
  'https://aiapp.bposupplychain.com',
  'https://aiapp.eigenracing.com',
]

test('every CRM record ID shape produces only a same-host relative path', () => {
  for (const prefix of CRM_PREFIXES) {
    for (const suffix of ['1234567', '0123456789ab']) {
      const reference = `${prefix}${suffix}`
      const path = crmRecordNavigationPath(reference, PIPELINE_ID)
      assert.equal(path, `/crm/${reference}?pipeline=${PIPELINE_ID}`)
      for (const origin of APP_ORIGINS) {
        const destination = new URL(path, origin)
        assert.equal(destination.origin, origin)
        assert.equal(destination.pathname, `/crm/${reference}`)
        assert.equal(destination.searchParams.get('pipeline'), PIPELINE_ID)
      }
    }
  }
})

test('normalizes a reference at the boundary without accepting a foreign URL', () => {
  assert.equal(crmRecordNavigationPath('  GI0123456789AB  '), '/crm/gi0123456789ab')
  for (const reference of [
    null,
    undefined,
    '',
    'gi123456',
    'gi12345678',
    'gi0123456789aw', // w is outside the supported base32hex suffix.
    'gu1234567',
    'gi1234567/../../',
    'gi1234567?next=https://attacker.example',
    'gi1234567#fragment',
    'gi1234567%2fother',
    '//attacker.example/crm/gi1234567',
    '/\\attacker.example/crm/gi1234567',
    'javascript:alert(1)',
    'https://eigenracing.com/s/gipebk1lgu9tk9',
    'https://aiapp.bposupplychain.com/crm/gi1234567',
  ]) {
    assert.equal(crmRecordNavigationPath(reference, PIPELINE_ID), null, String(reference))
  }
})

test('an invalid optional pipeline cannot inject a host, query, or path', () => {
  for (const pipeline of [
    '',
    null,
    undefined,
    '00000000-0000-0000-8000-000000000100', // Unsupported UUID version.
    '00000000-0000-4000-7000-000000000100', // Unsupported UUID variant.
    `${PIPELINE_ID}&next=https://attacker.example`,
    `${PIPELINE_ID}#fragment`,
    '../other-record',
    '//attacker.example',
    'javascript:alert(1)',
    'https://eigenracing.com/s/other-record',
  ]) {
    const path = crmRecordNavigationPath('gi1234567', pipeline)
    assert.equal(path, '/crm/gi1234567', String(pipeline))
    for (const origin of APP_ORIGINS) {
      assert.equal(new URL(path, origin).origin, origin)
    }
  }
})
