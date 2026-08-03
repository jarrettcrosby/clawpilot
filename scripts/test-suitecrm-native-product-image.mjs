#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = require('typescript')
const sharp = require('sharp')

async function importClient() {
  const url = new URL(
    '../app_src/lib/crm/suiteCrmNativeProductImageClient.ts',
    import.meta.url,
  )
  const source = await readFile(url, 'utf8')
  let output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: url.pathname,
  }).outputText
  output = output.replace(/^import[^\n]+\n/gm, '')
  output = `
const createHash = globalThis.__suiteCrmNativeImageTest.createHash
const sharp = globalThis.__suiteCrmNativeImageTest.sharp
const publicCrmProductImageUrl = globalThis.__suiteCrmNativeImageTest.publicUrl
const appPublicUrl = globalThis.__suiteCrmNativeImageTest.appPublicUrl
${output}`
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}

const PRODUCT_REFERENCE = 'gp0123456'
const PRODUCT_ID = '11111111-2222-5333-8444-555555555555'
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const OLD_MEDIA_ID = '99999999-8888-4777-8666-555555555555'
const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const IMAGE_SHA256 = createHash('sha256').update(IMAGE_BYTES).digest('hex')
const IMAGE_FILENAME = `${PRODUCT_REFERENCE}-${IMAGE_SHA256}.png`

globalThis.__suiteCrmNativeImageTest = {
  createHash,
  sharp,
  appPublicUrl: () => process.env.CLAWPILOT_PUBLIC_URL,
  publicUrl: ({ publicOrigin, productReferenceCode, contentSha256 }) =>
    `${publicOrigin}/api/public/crm-product-images/${productReferenceCode}/${contentSha256}`,
}

process.env.SUITECRM_BASE_URL = 'https://suitecrm.example.test'
process.env.CLAWPILOT_PUBLIC_URL = 'https://clawpilot.example.test'

const client = await importClient()

delete process.env.SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED
delete process.env.SUITECRM_MEDIA_USERNAME
delete process.env.SUITECRM_MEDIA_PASSWORD
delete process.env.SUITECRM_ADMIN_USER
delete process.env.SUITECRM_ADMIN_USERNAME
delete process.env.SUITECRM_ADMIN_PASSWORD
delete process.env.SUITECRM_CLIENT_ID
delete process.env.SUITECRM_CLIENT_SECRET
delete process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_ID
delete process.env.SUITECRM_PRODUCT_IMAGE_READ_CLIENT_SECRET
delete process.env.SUITECRM_PRODUCT_IMAGE_READ_USERNAME
delete process.env.SUITECRM_PRODUCT_IMAGE_READ_PASSWORD
assert.deepEqual(client.suiteCrmNativeProductImageProjectionConfiguration(), {
  enabled: false,
  ready: false,
  missing: ['SUITECRM_MEDIA_USERNAME', 'SUITECRM_MEDIA_PASSWORD'],
  invalid: [],
  credentialConflicts: [],
  credentialSeparationVerified: false,
})
let disabledFetches = 0
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), async () => {
    disabledFetches += 1
    throw new Error('disabled native media must not reach the network')
  }),
  { action: 'disabled', mediaId: null },
)
assert.equal(disabledFetches, 0)
await assert.rejects(
  client.projectSuiteCrmNativeProductImage({
    ...record({
      referenceCode: PRODUCT_REFERENCE,
      contentSha256: IMAGE_SHA256,
    }),
    productImageProjectionRequired: true,
  }, async () => {
    throw new Error('required disabled projection must not reach the network')
  }),
  /required but disabled/u,
)

process.env.SUITECRM_NATIVE_PRODUCT_IMAGE_PROJECTION_ENABLED = '1'
process.env.SUITECRM_MEDIA_USERNAME = 'clawpilot-media'
process.env.SUITECRM_MEDIA_PASSWORD = 'dedicated-media-password'
assert.deepEqual(client.suiteCrmNativeProductImageProjectionConfiguration(), {
  enabled: true,
  ready: true,
  missing: [],
  invalid: [],
  credentialConflicts: [],
  credentialSeparationVerified: true,
})
process.env.SUITECRM_ADMIN_USER = 'CLAWPILOT-MEDIA'
assert.deepEqual(
  client.suiteCrmNativeProductImageProjectionConfiguration()
    .credentialConflicts,
  ['SUITECRM_MEDIA_USERNAME:SUITECRM_ADMIN_USER'],
)
delete process.env.SUITECRM_ADMIN_USER

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mediaValue(id, originalName) {
  return {
    id,
    module: 'media-objects',
    attributes: { id, original_name: originalName },
  }
}

function headers(init) {
  return new Headers(init?.headers)
}

function mockSuiteCrm(input = {}) {
  const calls = []
  let savedFieldValue = null
  let current = input.current || null
  const saveInputs = []
  const expectedFilename = input.expectedFilename || IMAGE_FILENAME
  const expectedUploadMimeType = input.expectedUploadMimeType || 'image/png'
  const expectedUploadBytes = input.expectedUploadBytes || IMAGE_BYTES
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl))
    calls.push({ url, init })
    if (url.origin === 'https://clawpilot.example.test') {
      assert.equal(init.method, 'GET')
      const body = input.imageBytes || IMAGE_BYTES
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': input.mimeType || 'image/png',
          'content-length': String(input.contentLength || body.byteLength),
        },
      })
    }
    assert.equal(url.origin, 'https://suitecrm.example.test')
    if (url.pathname === '/session-status') {
      if (!headers(init).get('cookie')) {
        return jsonResponse(
          { active: false },
          200,
          {
            'set-cookie': 'XSRF-TOKEN=%2Finitial%3D; Path=/, SCRMSESSID=session-one; Path=/; HttpOnly',
          },
        )
      }
      assert.equal(
        headers(init).get('cookie'),
        'XSRF-TOKEN=%2Frotated%3D; SCRMSESSID=session-one',
      )
      assert.equal(headers(init).get('x-xsrf-token'), '/rotated=')
      return jsonResponse({ active: true })
    }
    if (url.pathname === '/login') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(String(init.body)), {
        username: 'clawpilot-media',
        password: 'dedicated-media-password',
      })
      assert.equal(
        headers(init).get('cookie'),
        'XSRF-TOKEN=%2Finitial%3D; SCRMSESSID=session-one',
      )
      assert.equal(headers(init).get('x-xsrf-token'), '/initial=')
      return jsonResponse(
        { login_success: 'true' },
        200,
        { 'set-cookie': 'XSRF-TOKEN=%2Frotated%3D; Path=/' },
      )
    }
    assert.equal(
      headers(init).get('cookie'),
      'XSRF-TOKEN=%2Frotated%3D; SCRMSESSID=session-one',
    )
    assert.equal(headers(init).get('x-xsrf-token'), '/rotated=')
    if (url.pathname === '/api/graphql') {
      const body = JSON.parse(String(init.body))
      if (body.operationName === 'ClawPilotProductImage') {
        assert.deepEqual(body.variables, { module: 'products', record: PRODUCT_ID })
        return jsonResponse({
          data: {
            record: {
              _id: PRODUCT_ID,
              module: 'products',
              attributes: current
                ? { id: PRODUCT_ID, clawpilot_image_c: current }
                : { id: PRODUCT_ID },
            },
          },
        })
      }
      assert.equal(body.operationName, 'ClawPilotSaveProductImage')
      assert.equal(body.variables.input._id, PRODUCT_ID)
      assert.equal(body.variables.input.module, 'products')
      assert.equal(body.variables.input.attributes.id, PRODUCT_ID)
      saveInputs.push(body.variables.input)
      savedFieldValue = body.variables.input.attributes.clawpilot_image_c
      const savedId = String(savedFieldValue.id || '')
      current = savedId ? mediaValue(savedId, expectedFilename) : null
      if (input.hideFirstSavedRecord && saveInputs.length === 1) {
        return jsonResponse({ data: { saveRecord: { record: null } } })
      }
      return jsonResponse({
        data: {
          saveRecord: {
            record: {
              _id: PRODUCT_ID,
              module: 'products',
              attributes: current
                ? { id: PRODUCT_ID, clawpilot_image_c: current }
                : { id: PRODUCT_ID },
            },
          },
        },
      })
    }
    if (url.pathname === '/api/private-image-media-objects') {
      assert.equal(init.method, 'POST')
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('parentType'), 'products')
      assert.equal(init.body.get('parentField'), 'clawpilot_image_c')
      const file = init.body.get('file')
      assert.ok(file instanceof Blob)
      assert.equal(file.name, expectedFilename)
      assert.equal(file.type, expectedUploadMimeType)
      assert.deepEqual(
        Buffer.from(await file.arrayBuffer()),
        Buffer.from(expectedUploadBytes),
      )
      return jsonResponse({
        id: MEDIA_ID,
        contentUrl: '/api/private-image-media-objects/media',
        originalName: expectedFilename,
        mimeType: expectedUploadMimeType,
        size: expectedUploadBytes.byteLength,
      }, 201)
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`)
  }
  return {
    calls,
    fetchImpl,
    saveInputs,
    savedFieldValue: () => savedFieldValue,
  }
}

function record(productImage) {
  return {
    entity: 'products',
    suiteCrmId: PRODUCT_ID,
    productImage,
  }
}

const attachedMock = mockSuiteCrm()
const attached = await client.projectSuiteCrmNativeProductImage(record({
  referenceCode: PRODUCT_REFERENCE,
  contentSha256: IMAGE_SHA256,
}), attachedMock.fetchImpl)
assert.deepEqual(attached, { action: 'attached', mediaId: MEDIA_ID })
assert.equal(
  attachedMock.calls.filter(({ url }) => url.pathname === '/api/private-image-media-objects').length,
  1,
)
assert.deepEqual(attachedMock.savedFieldValue(), {
  id: MEDIA_ID,
  module: 'media-objects',
  attributes: {
    id: MEDIA_ID,
    original_name: IMAGE_FILENAME,
    size: IMAGE_BYTES.byteLength,
    mime_type: 'image/png',
    contentUrl: '/api/private-image-media-objects/media',
  },
})
assert.equal(attachedMock.saveInputs.length, 1)

const WEBP_BYTES = await sharp(IMAGE_BYTES).webp({ lossless: true }).toBuffer()
const WEBP_SHA256 = createHash('sha256').update(WEBP_BYTES).digest('hex')
const SUITECRM_PNG_BYTES = await sharp(WEBP_BYTES, {
  failOn: 'warning',
  limitInputPixels: 40_000_000,
}).rotate().png({
  compressionLevel: 9,
  adaptiveFiltering: true,
}).toBuffer()
const WEBP_UPLOAD_FILENAME = `${PRODUCT_REFERENCE}-${WEBP_SHA256}.png`
const webpMock = mockSuiteCrm({
  imageBytes: WEBP_BYTES,
  mimeType: 'image/webp',
  expectedFilename: WEBP_UPLOAD_FILENAME,
  expectedUploadMimeType: 'image/png',
  expectedUploadBytes: SUITECRM_PNG_BYTES,
})
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: WEBP_SHA256,
  }), webpMock.fetchImpl),
  { action: 'attached', mediaId: MEDIA_ID },
)
assert.deepEqual(webpMock.savedFieldValue(), {
  id: MEDIA_ID,
  module: 'media-objects',
  attributes: {
    id: MEDIA_ID,
    original_name: WEBP_UPLOAD_FILENAME,
    size: SUITECRM_PNG_BYTES.byteLength,
    mime_type: 'image/png',
    contentUrl: '/api/private-image-media-objects/media',
  },
})

assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), attachedMock.fetchImpl),
  { action: 'unchanged', mediaId: MEDIA_ID },
)
assert.equal(
  attachedMock.calls.filter(({ url }) => url.pathname === '/api/private-image-media-objects').length,
  1,
  'a retry after an attached response must not upload another media object',
)
assert.equal(
  attachedMock.saveInputs.length,
  1,
  'a retry after an attached response must not save or create another Product',
)

const uncertainSaveMock = mockSuiteCrm({ hideFirstSavedRecord: true })
await assert.rejects(
  client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), uncertainSaveMock.fetchImpl),
  /unexpected saved Product image record/u,
)
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), uncertainSaveMock.fetchImpl),
  { action: 'unchanged', mediaId: MEDIA_ID },
)
assert.equal(
  uncertainSaveMock.calls.filter(
    ({ url }) => url.pathname === '/api/private-image-media-objects',
  ).length,
  1,
  'a retry after an uncertain save response must not upload another media object',
)
assert.equal(
  uncertainSaveMock.saveInputs.length,
  1,
  'a retry after an uncertain save response must not save or create another Product',
)

const unchangedMock = mockSuiteCrm({
  current: mediaValue(MEDIA_ID, IMAGE_FILENAME),
})
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), unchangedMock.fetchImpl),
  { action: 'unchanged', mediaId: MEDIA_ID },
)
assert.equal(
  unchangedMock.calls.some(({ url }) => url.origin === 'https://clawpilot.example.test'),
  false,
  'an attached deterministic media object must avoid re-fetch and re-upload',
)

const clearMock = mockSuiteCrm({
  current: mediaValue(OLD_MEDIA_ID, 'old-product.png'),
})
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record(null), clearMock.fetchImpl),
  { action: 'cleared', mediaId: null },
)
assert.deepEqual(clearMock.savedFieldValue(), {
  id: '',
  module: 'media-objects',
  attributes: { id: '' },
})
assert.equal(clearMock.saveInputs[0].attributes.id, PRODUCT_ID)
assert.equal(
  clearMock.calls.some(({ url }) => url.pathname === '/api/private-image-media-objects'),
  false,
)

const emptyClearMock = mockSuiteCrm()
assert.deepEqual(
  await client.projectSuiteCrmNativeProductImage(record(null), emptyClearMock.fetchImpl),
  { action: 'unchanged', mediaId: null },
)
assert.equal(emptyClearMock.savedFieldValue(), null)

const wrongShaMock = mockSuiteCrm()
await assert.rejects(
  client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: '0'.repeat(64),
  }), wrongShaMock.fetchImpl),
  /content identity does not match/u,
)
assert.equal(
  wrongShaMock.calls.some(({ url }) => url.pathname === '/api/private-image-media-objects'),
  false,
)

const oversizedMock = mockSuiteCrm({ contentLength: 2 * 1024 * 1024 + 1 })
await assert.rejects(
  client.projectSuiteCrmNativeProductImage(record({
    referenceCode: PRODUCT_REFERENCE,
    contentSha256: IMAGE_SHA256,
  }), oversizedMock.fetchImpl),
  /exceeds the SuiteCRM media limit/u,
)
assert.equal(
  oversizedMock.calls.some(({ url }) => url.pathname === '/api/private-image-media-objects'),
  false,
)

process.env.SUITECRM_ADMIN_USERNAME = 'admin-fallback-must-not-be-used'
process.env.SUITECRM_ADMIN_PASSWORD = 'admin-fallback-must-not-be-used'
process.env.SUITECRM_CLIENT_ID = 'oauth-fallback-must-not-be-used'
process.env.SUITECRM_CLIENT_SECRET = 'oauth-fallback-must-not-be-used'
delete process.env.SUITECRM_MEDIA_USERNAME
let missingCredentialFetches = 0
await assert.rejects(
  client.projectSuiteCrmNativeProductImage(record(null), async () => {
    missingCredentialFetches += 1
    throw new Error('network should not be reached')
  }),
  /SUITECRM_MEDIA_USERNAME is not configured safely/u,
)
assert.equal(missingCredentialFetches, 0)

const suiteCrmClientSource = readFileSync(
  new URL('../app_src/lib/crm/suiteCrmClient.ts', import.meta.url),
  'utf8',
)
const nativeProjectionPersistenceSource = readFileSync(
  new URL(
    '../app_src/lib/persistence/suiteCrmProductImageProjection.ts',
    import.meta.url,
  ),
  'utf8',
)
for (const contract of [
  'publicCrmProductImageUrl',
  'attributes.product_image',
  'projectSuiteCrmNativeProductImage',
  'if (record.productImage !== undefined)',
  'await projectSuiteCrmNativeProductImage(record, fetchImpl)',
]) {
  assert.ok(suiteCrmClientSource.includes(contract), `SuiteCRM client must include ${contract}`)
}
assert.ok(
  suiteCrmClientSource.indexOf("await request('/Api/V8/module'")
    < suiteCrmClientSource.indexOf('await projectSuiteCrmNativeProductImage(record, fetchImpl)'),
  'the existing V8 Product projection must complete before native media association',
)
for (const contract of [
  'WITH current_projections AS',
  "THEN 'crm:products:image:v1:' || product.id::text || ':none'",
  'LEFT JOIN LATERAL',
  'IS NOT DISTINCT FROM image.content_sha256',
]) {
  assert.ok(
    nativeProjectionPersistenceSource.includes(contract),
    `Native projection health must include current clear-image work: ${contract}`,
  )
}

console.log('SuiteCRM native Product image client contract passed')
