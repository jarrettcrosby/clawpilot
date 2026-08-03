#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')

function loadTypeScriptModule(path, mocks) {
  const source = readFileSync(resolve(root, path), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    Buffer,
    Date,
    Error,
    Map,
    Object,
    Promise,
    RangeError,
    Set,
    TypeError,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    fetch,
    module,
    process,
    setTimeout,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

class MockShopifyCommerceClientError extends Error {
  constructor(message, status = 502, code = 'SHOPIFY_UPSTREAM_FAILED', retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

const calls = []
let responder = async () => {
  throw new Error('Unexpected Shopify GraphQL call')
}

const client = loadTypeScriptModule(
  'app_src/lib/integrations/shopifyCarrierServiceClient.ts',
  {
    '@/lib/integrations/commerceCapabilities': {
      SHOPIFY_ADMIN_API_VERSION: '2026-07',
    },
    '@/lib/integrations/shopifyCommerceClient': {
      ShopifyCommerceClientError: MockShopifyCommerceClientError,
      async shopifyAdminGraphql(credential, input, options) {
        calls.push({ credential, input, options })
        return responder(credential, input, options)
      },
    },
  },
)

const credential = {
  shopDomain: 'ag-alchemy.myshopify.com',
  accessToken: 'test-access-token',
}
const gid = 'gid://shopify/DeliveryCarrierService/123456789'
const service = {
  id: gid,
  name: 'ClawPilot live checkout rates',
  callbackUrl: 'https://dev.example.com/api/shopify/rates/opaque-token',
  active: true,
  supportsServiceDiscovery: false,
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

assert.equal(client.SHOPIFY_CARRIER_SERVICE_API_VERSION, '2026-07')

responder = async (_credential, input) => {
  assert.equal(input.operationName, 'ClawPilotCarrierServiceCreate')
  assert.match(input.query, /DeliveryCarrierServiceCreateInput!/)
  assert.deepEqual(plain(input.variables), {
    input: {
      name: service.name,
      callbackUrl: service.callbackUrl,
      active: true,
      supportsServiceDiscovery: false,
    },
  })
  return {
    carrierServiceCreate: {
      carrierService: service,
      userErrors: [],
    },
  }
}
assert.deepEqual(
  plain(await client.createShopifyCarrierService(
    credential,
    {
      name: `  ${service.name}  `,
      callbackUrl: service.callbackUrl,
      active: true,
      supportsServiceDiscovery: false,
    },
    { timeoutMs: 5_000 },
  )),
  service,
)
assert.equal(calls.at(-1).options.timeoutMs, 5_000)

responder = async (_credential, input) => {
  assert.equal(input.operationName, 'ClawPilotCarrierService')
  assert.match(input.query, /carrierService\(id: \$id\)/)
  assert.deepEqual(plain(input.variables), { id: gid })
  return { carrierService: service }
}
assert.deepEqual(
  plain(await client.queryShopifyCarrierService(credential, gid)),
  service,
)

{
  let page = 0
  const secondService = {
    ...service,
    id: 'gid://shopify/DeliveryCarrierService/987654321',
    name: 'Existing backup rates',
  }
  responder = async (_credential, input) => {
    assert.equal(input.operationName, 'ClawPilotCarrierServices')
    assert.match(input.query, /carrierServices\(first: \$first, after: \$after\)/)
    assert.equal(input.variables.first, 250)
    if (page === 0) {
      assert.equal(input.variables.after, null)
      page += 1
      return {
        carrierServices: {
          nodes: [service],
          pageInfo: {
            hasNextPage: true,
            endCursor: 'carrier-cursor-1',
          },
        },
      }
    }
    assert.equal(input.variables.after, 'carrier-cursor-1')
    return {
      carrierServices: {
        nodes: [secondService],
        pageInfo: {
          hasNextPage: false,
          endCursor: 'carrier-cursor-2',
        },
      },
    }
  }
  assert.deepEqual(
    plain(await client.listShopifyCarrierServices(credential)),
    [service, secondService],
  )
}

responder = async () => ({
  carrierServices: {
    nodes: [],
    pageInfo: {
      hasNextPage: true,
      endCursor: 'repeated-cursor',
    },
  },
})
await assert.rejects(
  () => client.listShopifyCarrierServices(credential),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 502
    && error.code === 'SHOPIFY_CARRIER_SERVICE_LIST_INCOMPLETE',
)

responder = async () => ({
  carrierServices: {
    nodes: [service],
  },
})
await assert.rejects(
  () => client.listShopifyCarrierServices(credential),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 502
    && error.code === 'SHOPIFY_CARRIER_SERVICE_RESPONSE_INVALID',
)

responder = async (_credential, input) => {
  assert.equal(input.operationName, 'ClawPilotCarrierServiceUpdate')
  assert.match(input.query, /DeliveryCarrierServiceUpdateInput!/)
  assert.deepEqual(plain(input.variables), {
    input: {
      id: gid,
      active: false,
      supportsServiceDiscovery: true,
    },
  })
  return {
    carrierServiceUpdate: {
      carrierService: {
        ...service,
        active: false,
        supportsServiceDiscovery: true,
      },
      userErrors: [],
    },
  }
}
assert.equal(
  (
    await client.updateShopifyCarrierService(credential, {
      id: gid,
      active: false,
      supportsServiceDiscovery: true,
    })
  ).active,
  false,
)

responder = async (_credential, input) => {
  assert.equal(input.operationName, 'ClawPilotCarrierServiceDelete')
  assert.match(input.query, /carrierServiceDelete\(id: \$id\)/)
  assert.deepEqual(plain(input.variables), { id: gid })
  return {
    carrierServiceDelete: {
      deletedId: gid,
      userErrors: [],
    },
  }
}
assert.equal(
  await client.deleteShopifyCarrierService(credential, gid),
  gid,
)

responder = async () => ({
  carrierServiceCreate: {
    carrierService: null,
    userErrors: [
      {
        field: ['input', 'callbackUrl'],
        message: 'Callback URL is unavailable',
      },
    ],
  },
})
await assert.rejects(
  () => client.createShopifyCarrierService(credential, {
    name: service.name,
    callbackUrl: service.callbackUrl,
    active: true,
    supportsServiceDiscovery: false,
  }),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 422
    && error.code === 'SHOPIFY_CARRIER_SERVICE_CREATE_REJECTED'
    && error.userErrors[0]?.field.join('.') === 'input.callbackUrl',
)

await assert.rejects(
  () => client.updateShopifyCarrierService(credential, { id: gid }),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 400
    && error.code === 'SHOPIFY_CARRIER_SERVICE_UPDATE_EMPTY',
)

await assert.rejects(
  () => client.createShopifyCarrierService(credential, {
    name: service.name,
    callbackUrl: 'http://localhost:4002/api/shopify/rates',
    active: true,
    supportsServiceDiscovery: false,
  }),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 400
    && error.code === 'SHOPIFY_CARRIER_SERVICE_CALLBACK_INVALID',
)

responder = async () => ({
  carrierService: {
    ...service,
    id: 'gid://shopify/DeliveryCarrierService/987654321',
  },
})
await assert.rejects(
  () => client.queryShopifyCarrierService(credential, gid),
  (error) =>
    error instanceof client.ShopifyCarrierServiceClientError
    && error.status === 502
    && error.code === 'SHOPIFY_CARRIER_SERVICE_ID_MISMATCH',
)

console.log('Shopify CarrierService GraphQL client tests passed')
