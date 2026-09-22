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

test('accepts the exact BPO browser origin through its own Railway routing', () => {
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      host: 'clawpilot.railway.internal:8080',
      origin: 'https://aiapp.bposupplychain.com',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': 'aiapp.bposupplychain.com',
      'x-forwarded-proto': 'https',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
  }), true)
  assert.equal(isBrowserSameOriginRequest({
    headers: headers({
      host: 'clawpilot.railway.internal:8080',
      origin: 'https://dev.aiapp.bposupplychain.com',
      'sec-fetch-site': 'cross-site',
      'x-forwarded-host': 'aiapp.bposupplychain.com',
      'x-forwarded-proto': 'https',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
  }), false)
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

test('an exact secondary origin is trusted only in its configured environment', () => {
  const before = process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON
  const input = {
    headers: headers({
      origin: 'https://aiapp.bposupplychain.com',
      'sec-fetch-site': 'same-origin',
    }),
    requestOrigin: 'http://clawpilot.railway.internal:8080',
    trustedOrigins: ['https://aiapp.eigenracing.com'],
  }
  try {
    delete process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON
    assert.equal(isBrowserSameOriginRequest(input), false)
    process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON = '["https://aiapp.bposupplychain.com"]'
    assert.equal(isBrowserSameOriginRequest(input), true)
    assert.equal(isBrowserSameOriginRequest({
      ...input,
      headers: headers({
        origin: 'https://dev.aiapp.bposupplychain.com',
        'sec-fetch-site': 'same-origin',
      }),
    }), false)
  } finally {
    if (before === undefined) delete process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON
    else process.env.CLAWPILOT_ADDITIONAL_PUBLIC_ORIGINS_JSON = before
  }
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
      origin: 'null',
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
