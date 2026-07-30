import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isBrowserSameOriginRequest,
} from '../lib/browserSameOrigin.ts'

function headers(values: Record<string, string>) {
  return new Headers(values)
}

test('accepts a direct same-origin browser request', () => {
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      origin: 'http://localhost:4002',
      'sec-fetch-site': 'same-origin',
    }),
    requestOrigin: 'http://localhost:4002',
  }), true)
})

test('accepts the HTTPS public origin routed through Railway', () => {
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      host: 'clawpilot.railway.internal:8080',
      origin: 'https://dev.aiapp.eigenracing.com',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'dev.aiapp.eigenracing.com',
      'x-forwarded-proto': 'https',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
  }), true)
})

test('accepts the configured Railway public origin when proxy headers are absent', () => {
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      origin: 'https://dev.aiapp.eigenracing.com',
      'sec-fetch-site': 'same-origin',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
    trustedOrigins: [
      'https://dev.aiapp.eigenracing.com',
    ],
  }), true)
})

test('rejects missing, cross-site, unrelated, and scheme-mismatched origins', () => {
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      'sec-fetch-site': 'same-origin',
    }),
    requestOrigin: 'https://dev.aiapp.eigenracing.com',
  }), false)
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      origin: 'https://dev.aiapp.eigenracing.com',
      'sec-fetch-site': 'cross-site',
    }),
    requestOrigin: 'https://dev.aiapp.eigenracing.com',
  }), false)
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      host: 'dev.aiapp.eigenracing.com',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
    trustedOrigins: [
      'https://dev.aiapp.eigenracing.com',
    ],
  }), false)
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      host: 'dev.aiapp.eigenracing.com',
      origin: 'http://dev.aiapp.eigenracing.com',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
    trustedOrigins: [
      'https://dev.aiapp.eigenracing.com',
    ],
  }), false)
})

test('rejects ambiguous forwarded host and protocol headers', () => {
  for (const values of [
    {
      'x-forwarded-host':
        'dev.aiapp.eigenracing.com, proxy.internal',
      'x-forwarded-proto': 'https',
    },
    {
      'x-forwarded-host': 'dev.aiapp.eigenracing.com',
      'x-forwarded-proto': 'https, http',
    },
  ]) {
    assert.equal(isBrowserSameOriginRequest({
      headers: headers({
        host: 'clawpilot.railway.internal:8080',
        origin: 'https://dev.aiapp.eigenracing.com',
        'sec-fetch-site': 'same-origin',
        ...values,
      }),
      requestOrigin: 'http://clawpilot.railway.internal:8080',
    }), false)
  }
})
