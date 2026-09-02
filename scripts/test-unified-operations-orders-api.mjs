#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  loadTypeScriptModule,
} from './test-commerce-order-revisions-postgres.mjs'

class OperationsRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const route = loadTypeScriptModule(
  'app_src/app/api/operations/orders/unified/route.ts',
  {
    'next/server': {
      NextResponse: {
        json(payload, options) {
          return {
            payload,
            status: options.status,
            headers: options.headers,
          }
        },
      },
    },
    '@/lib/operations/orderListQuery': {
      isOperationsOrderProviderFilter: () => true,
      isOperationsOrderSortDirection: () => true,
      isOperationsOrderTrackingFilter: () => true,
      isOperationsOrderUpdatedAfter: () => true,
    },
    '@/lib/operations/unifiedOrderPage': {
      MAX_UNIFIED_OPERATIONS_ORDER_PAGE_SIZE: 100,
      isUnifiedOperationsOrderSort: () => true,
    },
    '@/lib/operations/authorization': {
      activeOperationsOrganizationId() {
        throw new Error('ACTIVE_ORGANIZATION_REQUIRED')
      },
      operationsCapabilities: () => ({ canView: true }),
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled: () => true,
    },
    '@/lib/persistence/operations': { OperationsRequestError },
    '@/lib/persistence/unifiedOperationsOrderPage': {
      readUnifiedOperationsOrderPageFromPostgres() {
        assert.fail('A request without an active organization must not read orders')
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => ({ email: 'operator@clawpilot.test' }),
    },
  },
)

const result = await route.GET({
  nextUrl: new URL(
    'http://localhost/api/operations/orders/unified?pageSize=50',
  ),
})

assert.equal(result.status, 409)
assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), {
  ok: false,
  code: 'ACTIVE_ORGANIZATION_REQUIRED',
  error: 'Select an active organization first',
})
assert.equal(result.headers['Cache-Control'], 'private, no-store')
assert.equal(result.headers.Vary, 'Cookie')

console.log('Unified operations orders API contract passed')
