import assert from 'node:assert/strict'
import test from 'node:test'
import {
  additionalPublicOrigins,
  browserReturnOrigin,
} from '../lib/publicOriginRouting.mjs'

const canonicalOrigin = 'https://aiapp.eigenracing.com'
const bpoOrigin = 'https://aiapp.bposupplychain.com'
const additionalOrigins = [bpoOrigin]

function headers(values: Record<string, string> = {}) {
  return new Headers(values)
}

test('additional public origins must be bounded exact HTTPS origins', () => {
  assert.deepEqual(additionalPublicOrigins(undefined), [])
  assert.deepEqual(additionalPublicOrigins(`["${bpoOrigin}"]`), [bpoOrigin])
  for (const value of [
    `["http://aiapp.bposupplychain.com"]`,
    `["${bpoOrigin}/path"]`,
    `["${bpoOrigin}/"]`,
    `["${bpoOrigin}","${bpoOrigin}"]`,
    `["https://*.bposupplychain.com"]`,
    `["https://user@aiapp.bposupplychain.com"]`,
    '{}',
  ]) {
    assert.throws(() => additionalPublicOrigins(value))
  }
})

test('browser deep links stay on either exact allowed host', () => {
  assert.equal(browserReturnOrigin({
    canonicalOrigin,
    additionalOrigins,
    requestUrl: `${canonicalOrigin}/crm/gc123`,
    headers: headers(),
  }), canonicalOrigin)
  assert.equal(browserReturnOrigin({
    canonicalOrigin,
    additionalOrigins,
    requestUrl: `${bpoOrigin}/crm/gc123`,
    headers: headers(),
  }), bpoOrigin)
})

test('Railway internal routing may use only an exact allowlisted forwarded host', () => {
  const requestUrl = 'http://clawpilot.railway.internal:8080/crm/gc123'
  assert.equal(browserReturnOrigin({
    canonicalOrigin,
    additionalOrigins,
    requestUrl,
    headers: headers({
      'x-forwarded-host': 'aiapp.bposupplychain.com',
      'x-forwarded-proto': 'https',
    }),
  }), bpoOrigin)
  for (const forwarded of [
    { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'aiapp.bposupplychain.com.evil', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'aiapp.bposupplychain.com, attacker.example', 'x-forwarded-proto': 'https' },
    { 'x-forwarded-host': 'aiapp.bposupplychain.com', 'x-forwarded-proto': 'http' },
    { 'x-forwarded-host': 'aiapp.bposupplychain.com', 'x-forwarded-proto': 'https, http' },
  ]) {
    assert.equal(browserReturnOrigin({
      canonicalOrigin,
      additionalOrigins,
      requestUrl,
      headers: headers(forwarded),
    }), canonicalOrigin)
  }
})

test('a directly allowed request origin wins over inconsistent forwarding', () => {
  assert.equal(browserReturnOrigin({
    canonicalOrigin,
    additionalOrigins,
    requestUrl: `${canonicalOrigin}/crm/gc123`,
    headers: headers({
      'x-forwarded-host': 'aiapp.bposupplychain.com',
      'x-forwarded-proto': 'https',
    }),
  }), canonicalOrigin)
})
