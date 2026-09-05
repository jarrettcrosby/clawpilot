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
    '@/lib/integrations/integrationCredentialRuntimeHttp': {
      integrationCredentialRuntimeMaintenanceResponse: () => null,
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

let capturedInput = null
const activeRoute = loadTypeScriptModule(
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
      activeOperationsOrganizationId: () => (
        '00000000-0000-4000-8000-000000000001'
      ),
      operationsCapabilities: () => ({ canView: true }),
    },
    '@/lib/integrations/integrationCredentialRuntimeHttp': {
      integrationCredentialRuntimeMaintenanceResponse: () => null,
    },
    '@/lib/persistence/config': {
      isPostgresStorageEnabled: () => true,
    },
    '@/lib/persistence/operations': { OperationsRequestError },
    '@/lib/persistence/unifiedOperationsOrderPage': {
      readUnifiedOperationsOrderPageFromPostgres(input) {
        capturedInput = input
        return {
          rows: [],
          page: {
            total: 0,
            returned: 0,
            pageSize: input.pageSize,
            offset: 0,
            nextCursor: null,
            complete: true,
            truncated: false,
            snapshot: 'snapshot-token',
          },
        }
      },
    },
    '@/lib/requestUser': {
      requireRequestUser: async () => ({ email: 'operator@clawpilot.test' }),
    },
  },
)

const directPageResult = await activeRoute.GET({
  nextUrl: new URL(
    'http://localhost/api/operations/orders/unified?page=7&pageSize=25&snapshot=prior-token',
  ),
})
assert.equal(directPageResult.status, 200)
assert.equal(capturedInput.page, 7)
assert.equal(capturedInput.cursor, null)
assert.equal(capturedInput.snapshot, 'prior-token')
assert.equal(capturedInput.pageSize, 25)

capturedInput = null
const conflictResult = await activeRoute.GET({
  nextUrl: new URL(
    'http://localhost/api/operations/orders/unified?page=2&cursor=abc&pageSize=25',
  ),
})
assert.equal(conflictResult.status, 400)
assert.equal(
  conflictResult.payload.code,
  'OPERATIONS_UNIFIED_ORDER_PAGE_CURSOR_CONFLICT',
)
assert.equal(capturedInput, null)

for (const page of ['', '0', '-1', '1.5', '9007199254740992']) {
  const invalidPageResult = await activeRoute.GET({
    nextUrl: new URL(
      `http://localhost/api/operations/orders/unified?page=${encodeURIComponent(page)}`,
    ),
  })
  assert.equal(invalidPageResult.status, 400)
  assert.equal(
    invalidPageResult.payload.code,
    'OPERATIONS_UNIFIED_ORDER_PAGE_INVALID',
  )
}

for (const snapshot of ['bad token', 'bad.token']) {
  const invalidSnapshotResult = await activeRoute.GET({
    nextUrl: new URL(
      `http://localhost/api/operations/orders/unified?page=2&snapshot=${encodeURIComponent(snapshot)}`,
    ),
  })
  assert.equal(invalidSnapshotResult.status, 400)
  assert.equal(
    invalidSnapshotResult.payload.code,
    'OPERATIONS_ORDER_PAGE_SNAPSHOT_INVALID',
  )
}

console.log('Unified operations orders API contract passed')
