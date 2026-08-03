#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

import {
  confirmationForTarget,
  nativeProjectionConfiguration,
  targetFingerprint,
} from './requeue-suitecrm-native-product-image.mjs'

const target = {
  organization_id: '11111111-2222-4333-8444-555555555555',
  pipeline_id: '22222222-3333-4444-8555-666666666666',
  product_id: '33333333-4444-4555-8666-777777777777',
  suitecrm_id: '44444444-5555-4666-8777-888888888888',
  reference_code: 'gp0123456',
  image_asset_id: '55555555-6666-4777-8888-999999999999',
  image_asset_revision: 3,
  image_row_version: 7,
  image_content_sha256: 'a'.repeat(64),
}

assert.match(targetFingerprint(target), /^[0-9a-f]{64}$/u)
assert.equal(targetFingerprint(target), targetFingerprint({ ...target }))
assert.notEqual(
  targetFingerprint(target),
  targetFingerprint({ ...target, image_row_version: 8 }),
)
assert.equal(
  confirmationForTarget(target),
  `suitecrm-native-product-image:${target.reference_code}:${
    targetFingerprint(target)
  }`,
)

const readyEnvironment = {
  SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED: '1',
  SUITECRM_BASE_URL: 'http://suitecrm.railway.internal:8080',
  CLAWPILOT_PUBLIC_URL: 'https://clawpilot.example.test',
  SUITECRM_MEDIA_USERNAME: 'clawpilot-media',
  SUITECRM_MEDIA_PASSWORD: 'dedicated-media-password',
  SUITECRM_ADMIN_USER: 'administrator',
  SUITECRM_ADMIN_PASSWORD: 'different-administrator-password',
  SUITECRM_CLIENT_ID: 'different-oauth-client',
  SUITECRM_CLIENT_SECRET: 'different-oauth-secret',
}
assert.deepEqual(nativeProjectionConfiguration(readyEnvironment), {
  enabled: true,
  ready: true,
  missing: [],
  invalid: [],
  credentialConflicts: [],
})
assert.deepEqual(
  nativeProjectionConfiguration({
    ...readyEnvironment,
    SUITECRM_ADMIN_USER: 'CLAWPILOT-MEDIA',
  }).credentialConflicts,
  ['SUITECRM_MEDIA_USERNAME:SUITECRM_ADMIN_USER'],
)
assert.equal(
  nativeProjectionConfiguration({
    ...readyEnvironment,
    SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED: '0',
  }).ready,
  false,
)

const worker = readFileSync(
  resolve('app_src/lib/crm/worker.ts'),
  'utf8',
)
const persistence = readFileSync(
  resolve('app_src/lib/persistence/crm.ts'),
  'utf8',
)
const command = readFileSync(
  resolve('scripts/requeue-suitecrm-native-product-image.mjs'),
  'utf8',
)

assert.match(worker, /upsertSuiteCrmRecordWithResult/u)
assert.match(worker, /completeSuiteCrmOutboxInPostgres\(item, \{/u)
assert.match(worker, /productImageProjection,/u)
assert.match(
  persistence,
  /crm\.product_image\.suitecrm_native_projection_completed/u,
)
assert.match(persistence, /mediaId: completion\.productImageProjection\.mediaId/u)
assert.match(
  persistence,
  /crm-product-image-suitecrm-native-result:\$\{item\.id\}:\$\{item\.attempts\}/u,
)
assert.match(command, /productImageProjectionRequired: true/u)
assert.match(command, /status <> 'processing'/u)
assert.match(
  command,
  /crm\.product_image\.suitecrm_native_reprojection_queued/u,
)
assert.match(command, /providerWrites: 0/u)

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const workerOutput = ts.transpileModule(worker, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: 'app_src/lib/crm/worker.ts',
}).outputText
const workerModule = { exports: {} }
const completed = []
const mediaId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const item = {
  id: '11111111-2222-4333-8444-555555555555',
  aggregateType: 'crm_products',
  aggregateId: '22222222-3333-4444-8555-666666666666',
  idempotencyKey: 'crm:products:image:v1:test',
  operation: 'upsert_record',
  attempts: 1,
  lockToken: 'worker-lock-token',
  payload: {
    entity: 'products',
    pipelineId: '33333333-4444-4555-8666-777777777777',
    localId: '22222222-3333-4444-8555-666666666666',
    suiteCrmId: '44444444-5555-4666-8777-888888888888',
    attributes: {},
    productImage: {
      referenceCode: 'gp0123456',
      contentSha256: 'a'.repeat(64),
    },
    productImageProjectionRequired: true,
  },
}
vm.runInNewContext(workerOutput, {
  Array,
  Boolean,
  Error,
  Map,
  Math,
  Number,
  Object,
  Promise,
  String,
  console,
  exports: workerModule.exports,
  module: workerModule,
  require(specifier) {
    if (specifier === '@/lib/crm/suiteCrmClient') {
      return {
        deleteSuiteCrmRecord: async () => undefined,
        upsertSuiteCrmRecordWithResult: async () => ({
          suiteCrmId: item.payload.suiteCrmId,
          productImageProjection: { action: 'attached', mediaId },
        }),
        upsertSuiteCrmUserIdentity: async () => undefined,
      }
    }
    if (specifier === '@/lib/persistence/crm') {
      return {
        claimSuiteCrmOutboxInPostgres: async () => [item],
        completeSuiteCrmOutboxInPostgres: async (...args) => {
          completed.push(args)
        },
        failSuiteCrmOutboxInPostgres: async () => {
          throw new Error('worker success fixture must not fail')
        },
        readCrmWorkbookProjectionContext: async () => null,
        readCrmWorkbookProjectionReadiness: async () => ({ ready: false }),
        writeSuiteCrmWorkerHeartbeat: async () => undefined,
      }
    }
    if (specifier === '@/lib/persistence/pipeline') {
      return {
        enqueuePipelineSyncOutboxInPostgres: async () => {
          throw new Error('workbook projection must not be queued')
        },
      }
    }
    throw new Error(`Unexpected worker dependency: ${specifier}`)
  },
})
const workerResult = await workerModule.exports.processSuiteCrmOutbox()
assert.equal(workerResult.succeeded, 1)
assert.equal(completed.length, 1)
assert.equal(completed[0][0], item)
assert.equal(
  completed[0][1].productImageProjection.action,
  'attached',
)
assert.equal(completed[0][1].productImageProjection.mediaId, mediaId)

console.log('SuiteCRM native Product image reprojection tests passed')
