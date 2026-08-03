#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const root = process.cwd()
const nodeRequire = createRequire(import.meta.url)
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const ts = requireFromApp('typescript')
const sharpModule = requireFromApp('sharp')

function loadTypeScriptModule(path, { mocks = {} } = {}) {
  const output = ts.transpileModule(
    readFileSync(resolve(root, path), 'utf8'),
    {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: path,
    },
  ).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Array,
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    Symbol,
    Uint8Array,
    Uint32Array,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (Object.prototype.hasOwnProperty.call(mocks, specifier)) {
        return mocks[specifier]
      }
      return nodeRequire(specifier)
    },
    setTimeout,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const productImageAssets = loadTypeScriptModule(
  'app_src/lib/crm/productImageAssets.ts',
)
const providerImages = loadTypeScriptModule(
  'app_src/lib/integrations/commerceProviderImageFetch.ts',
  {
    mocks: {
      '@/lib/crm/productImageAssets': productImageAssets,
      sharp: sharpModule,
    },
  },
)

const {
  COMMERCE_PROVIDER_IMAGE_MAX_REDIRECTS,
  COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES,
  fetchCommerceProviderImage,
} = providerImages
const { CRM_PRODUCT_IMAGE_MAX_BYTES } = productImageAssets

const ONE_PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

function losslessWebpFixture(width, height) {
  const dimensionBits = (
    (width - 1)
    | ((height - 1) << 14)
  ) >>> 0
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    0x12, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c,
    0x05, 0x00, 0x00, 0x00,
    0x2f,
    dimensionBits & 0xff,
    (dimensionBits >>> 8) & 0xff,
    (dimensionBits >>> 16) & 0xff,
    (dimensionBits >>> 24) & 0xff,
    0x00,
  ])
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? (0xedb88320 ^ (value >>> 1))
        : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
})()

function pngCrc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + payload.byteLength)
  chunk.writeUInt32BE(payload.byteLength, 0)
  typeBytes.copy(chunk, 4)
  Buffer.from(payload).copy(chunk, 8)
  chunk.writeUInt32BE(
    pngCrc32(chunk.subarray(4, 8 + payload.byteLength)),
    8 + payload.byteLength,
  )
  return chunk
}

function pngWithAncillaryPayload(payloadByteLength) {
  const source = Buffer.from(ONE_PIXEL_PNG)
  const endOffset = source.byteLength - 12
  assert.equal(source.toString('ascii', endOffset + 4, endOffset + 8), 'IEND')
  return Uint8Array.from(Buffer.concat([
    source.subarray(0, endOffset),
    pngChunk('vpAg', Buffer.alloc(payloadByteLength, 0x61)),
    source.subarray(endOffset),
  ]))
}

function pngWithInvalidCompressedData() {
  const bytes = Buffer.from(ONE_PIXEL_PNG)
  let offset = 8
  while (offset < bytes.byteLength) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') {
      bytes.fill(0, offset + 8, offset + 8 + length)
      bytes.writeUInt32BE(
        pngCrc32(bytes.subarray(offset + 4, offset + 8 + length)),
        offset + 8 + length,
      )
    }
    offset += 12 + length
  }
  return Uint8Array.from(bytes)
}

const STRUCTURAL_ONLY_JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b,
  0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08,
  0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00,
  0xff, 0xd9,
])

function response({
  status = 200,
  headers = {},
  chunks = [ONE_PIXEL_PNG],
} = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  )
  const state = { cancelled: false }
  const body = chunks === null
    ? null
    : {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      }
  return {
    response: {
      body,
      cancel() {
        state.cancelled = true
      },
      headers: {
        get(name) {
          return normalizedHeaders.get(name.toLowerCase()) ?? null
        },
      },
      status,
    },
    state,
  }
}

function safeDependencies(overrides = {}) {
  return {
    clearScheduledTimeout() {},
    async fetch() {
      return response({ headers: { 'content-type': 'image/png' } }).response
    },
    async lookup() {
      return [{ address: '93.184.216.34', family: 4 }]
    },
    now: () => 0,
    scheduleTimeout: () => Symbol('timer'),
    ...overrides,
  }
}

async function expectCode(promise, code, secrets = []) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, 'CommerceProviderImageFetchError')
    assert.equal(error?.code, code)
    assert.equal(typeof error?.message, 'string')
    for (const secret of secrets) {
      assert.equal(
        error.message.includes(secret),
        false,
        `stable error leaked ${secret}`,
      )
    }
    return true
  })
}

test('prefers public IPv4 from dual-stack DNS and returns validated bytes only', async () => {
  const requests = []
  const lookups = []
  const result = await fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/item.png?token=do-not-return' },
    safeDependencies({
      async lookup(hostname) {
        lookups.push(hostname)
        return [
          { address: '2606:4700:4700::1111', family: 6 },
          { address: '93.184.216.34', family: 4 },
        ]
      },
      async fetch(request) {
        requests.push(request)
        return response({
          chunks: [ONE_PIXEL_PNG.subarray(0, 19), ONE_PIXEL_PNG.subarray(19)],
          headers: {
            'content-length': ONE_PIXEL_PNG.byteLength,
            'content-type': 'image/png; charset=binary',
          },
        }).response
      },
    }),
  )

  assert.deepEqual(lookups, ['images.vendor.com'])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].address, {
    address: '93.184.216.34',
    family: 4,
  })
  assert.equal(requests[0].url.hostname, 'images.vendor.com')
  assert.equal(requests[0].headers.Authorization, undefined)
  assert.equal(requests[0].headers.Cookie, undefined)
  assert.deepEqual(Object.keys(result).sort(), [
    'byteLength',
    'bytes',
    'contentSha256',
    'mediaType',
    'normalizationVersion',
    'pixelHeight',
    'pixelWidth',
    'sourceByteLength',
    'sourceContentSha256',
  ])
  assert.deepEqual(result.bytes, ONE_PIXEL_PNG)
  assert.equal(result.byteLength, ONE_PIXEL_PNG.byteLength)
  assert.equal(result.contentSha256, createHash('sha256')
    .update(ONE_PIXEL_PNG).digest('hex'))
  assert.equal(result.mediaType, 'image/png')
  assert.equal(result.normalizationVersion, 'identity-v1')
  assert.equal(result.pixelWidth, 1)
  assert.equal(result.pixelHeight, 1)
  assert.equal(result.sourceByteLength, ONE_PIXEL_PNG.byteLength)
  assert.equal(result.sourceContentSha256, result.contentSha256)
})

test('default DNS resolution selects IPv4 while retaining IPv6-only support', async () => {
  const requests = []
  const resolverCalls = []
  const run = async ({ ipv4, ipv6 }) => fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/item.png' },
    {
      clearScheduledTimeout() {},
      createResolver() {
        return {
          cancel() {},
          async resolve4(hostname) {
            resolverCalls.push(['resolve4', hostname])
            return ipv4
          },
          async resolve6(hostname) {
            resolverCalls.push(['resolve6', hostname])
            return ipv6
          },
        }
      },
      async fetch(request) {
        requests.push(request)
        return response({ headers: { 'content-type': 'image/png' } }).response
      },
      now: () => 0,
      scheduleTimeout: () => Symbol('timer'),
    },
  )

  await run({
    ipv4: ['93.184.216.34'],
    ipv6: ['2606:4700:4700::1111'],
  })
  await run({
    ipv4: [],
    ipv6: ['2606:4700:4700::1111'],
  })

  assert.deepEqual(requests.map((request) => ({
    address: request.address.address,
    family: request.address.family,
  })), [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])
  assert.deepEqual(resolverCalls, [
    ['resolve6', 'images.vendor.com'],
    ['resolve4', 'images.vendor.com'],
    ['resolve6', 'images.vendor.com'],
    ['resolve4', 'images.vendor.com'],
  ])
})

test('native HTTPS transport preserves authority while using only the pinned address', async () => {
  let capturedUrl
  let capturedOptions
  const fakeResponse = {
    async *[Symbol.asyncIterator]() {
      yield ONE_PIXEL_PNG
    },
    destroy() {},
    headers: {
      'content-length': String(ONE_PIXEL_PNG.byteLength),
      'content-type': 'image/png',
    },
    statusCode: 200,
  }
  const nativeTransportProviderImages = loadTypeScriptModule(
    'app_src/lib/integrations/commerceProviderImageFetch.ts',
    {
      mocks: {
        '@/lib/crm/productImageAssets': productImageAssets,
        'node:https': {
          request(url, options, callback) {
            capturedUrl = url
            capturedOptions = options
            return {
              end() {
                callback(fakeResponse)
              },
              on() {
                return this
              },
            }
          },
        },
        sharp: sharpModule,
      },
    },
  )

  const result = await nativeTransportProviderImages.fetchCommerceProviderImage(
    { url: 'https://images.vendor.com:8443/item.png?token=do-not-log' },
    {
      clearScheduledTimeout() {},
      async lookup() {
        return [{ address: '93.184.216.34', family: 4 }]
      },
      now: () => 0,
      scheduleTimeout: () => Symbol('timer'),
    },
  )

  assert.equal(result.pixelWidth, 1)
  assert.equal(capturedUrl.hostname, 'images.vendor.com')
  assert.equal(capturedUrl.port, '8443')
  assert.equal(capturedOptions.headers.Host, 'images.vendor.com:8443')
  assert.equal(capturedOptions.servername, 'images.vendor.com')
  assert.equal(capturedOptions.agent, false)
  const pinned = await new Promise((resolve, reject) => {
    capturedOptions.lookup(
      'images.vendor.com',
      { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses),
    )
  })
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].address, '93.184.216.34')
  assert.equal(pinned[0].family, 4)
})

test('rejects invalid, non-HTTPS, credentialed, and reserved-name URLs', async () => {
  let networkCalls = 0
  const dependencies = safeDependencies({
    async fetch() {
      networkCalls += 1
      assert.fail('URL validation must precede the network boundary')
    },
    async lookup() {
      networkCalls += 1
      assert.fail('URL validation must precede DNS')
    },
  })
  await expectCode(
    fetchCommerceProviderImage({ url: 'not a URL' }, dependencies),
    'COMMERCE_PROVIDER_IMAGE_URL_INVALID',
  )
  await expectCode(
    fetchCommerceProviderImage({ url: 'http://images.vendor.com/a.png' }, dependencies),
    'COMMERCE_PROVIDER_IMAGE_HTTPS_REQUIRED',
  )
  await expectCode(
    fetchCommerceProviderImage({
      url: 'https://api-user:super-secret@images.vendor.com/a.png',
    }, dependencies),
    'COMMERCE_PROVIDER_IMAGE_CREDENTIALS_FORBIDDEN',
    ['api-user', 'super-secret', 'images.vendor.com'],
  )
  for (const hostname of [
    'localhost',
    'assets.localhost',
    'assets.local',
    'metadata.internal',
    'images.test',
    'hidden.onion',
  ]) {
    await expectCode(
      fetchCommerceProviderImage({ url: `https://${hostname}/a.png` }, dependencies),
      'COMMERCE_PROVIDER_IMAGE_HOST_FORBIDDEN',
      [hostname],
    )
  }
  assert.equal(networkCalls, 0)
})

test('rejects unsafe IPv4 and IPv6 literals without DNS or HTTP', async () => {
  let networkCalls = 0
  const dependencies = safeDependencies({
    async fetch() {
      networkCalls += 1
      assert.fail('unsafe literals must not be fetched')
    },
    async lookup() {
      networkCalls += 1
      assert.fail('IP literals must not be resolved')
    },
  })
  for (const url of [
    'https://127.0.0.1/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.2/image.png',
    'https://224.0.0.1/image.png',
    'https://[::1]/image.png',
    'https://[::ffff:7f00:1]/image.png',
    'https://[fc00::1]/image.png',
    'https://[fe80::1]/image.png',
    'https://[2001:db8::1]/image.png',
    'https://[ff02::1]/image.png',
  ]) {
    await expectCode(
      fetchCommerceProviderImage({ url }, dependencies),
      'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE',
      [url],
    )
  }
  assert.equal(networkCalls, 0)
})

test('rejects unsafe, malformed, mixed, empty, and failed DNS answers', async () => {
  let fetchCalls = 0
  const noFetch = async () => {
    fetchCalls += 1
    assert.fail('unsafe DNS results must not reach HTTP')
  }
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png' },
    safeDependencies({
      fetch: noFetch,
      lookup: async () => [{ address: '10.0.0.7', family: 4 }],
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE')
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png' },
    safeDependencies({
      fetch: noFetch,
      lookup: async () => [{ address: '::ffff:10.0.0.7', family: 6 }],
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE')
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png' },
    safeDependencies({
      fetch: noFetch,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_MIXED')
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png' },
    safeDependencies({
      fetch: noFetch,
      lookup: async () => [{ address: '93.184.216.34', family: 6 }],
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE')
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png' },
    safeDependencies({ fetch: noFetch, lookup: async () => [] }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_EMPTY')
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/a.png?token=dns-secret' },
    safeDependencies({
      fetch: noFetch,
      lookup: async () => {
        throw new Error('resolver leaked dns-secret and images.vendor.com')
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_FAILED', [
    'dns-secret',
    'images.vendor.com',
  ])
  assert.equal(fetchCalls, 0)
})

test('cancels native DNS resolution when the total deadline expires', async () => {
  let cancelCalls = 0
  let resolveCalls = 0
  let fireTimeout = () => assert.fail('timeout was not scheduled')
  const pendingRejects = []
  const stalledResolution = () => {
    resolveCalls += 1
    return new Promise((_resolve, reject) => pendingRejects.push(reject))
  }
  const promise = fetchCommerceProviderImage(
    { url: 'https://slow-dns.vendor.com/image.png', timeoutMs: 25 },
    {
      clearScheduledTimeout() {},
      createResolver() {
        return {
          cancel() {
            cancelCalls += 1
            const error = Object.assign(new Error('resolver detail'), {
              code: 'ECANCELLED',
            })
            for (const reject of pendingRejects.splice(0)) reject(error)
          },
          resolve4: stalledResolution,
          resolve6: stalledResolution,
        }
      },
      async fetch() {
        assert.fail('HTTP must not run while DNS is unresolved')
      },
      now: () => 0,
      scheduleTimeout(callback, delayMs) {
        assert.equal(delayMs, 25)
        fireTimeout = callback
        return Symbol('timer')
      },
    },
  )
  assert.equal(resolveCalls, 2)
  fireTimeout()
  await expectCode(promise, 'COMMERCE_PROVIDER_IMAGE_TIMEOUT', [
    'resolver detail',
    'slow-dns.vendor.com',
  ])
  assert.equal(cancelCalls, 1)
})

test('revalidates DNS and pins a fresh public address for every redirect', async () => {
  const lookups = []
  const requests = []
  const redirected = response({
    status: 302,
    headers: { location: 'https://cdn.vendor.com/final.png?token=redirect-secret' },
    chunks: [],
  })
  const final = response({
    headers: { 'content-type': 'image/png' },
  })
  const result = await fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/start.png' },
    safeDependencies({
      async fetch(request) {
        requests.push(request)
        return requests.length === 1 ? redirected.response : final.response
      },
      async lookup(hostname) {
        lookups.push(hostname)
        return [{
          address: hostname === 'images.vendor.com'
            ? '93.184.216.34'
            : '104.16.132.229',
          family: 4,
        }]
      },
    }),
  )

  assert.deepEqual(lookups, ['images.vendor.com', 'cdn.vendor.com'])
  assert.deepEqual(requests.map((request) => request.address.address), [
    '93.184.216.34',
    '104.16.132.229',
  ])
  assert.equal(redirected.state.cancelled, true)
  assert.equal(result.contentSha256.length, 64)
})

test('blocks DNS rebinding and unsafe redirect destinations before a second request', async () => {
  let lookupCalls = 0
  let fetchCalls = 0
  const redirected = response({
    status: 307,
    headers: { location: '/second.png?token=rebind-secret' },
    chunks: [],
  })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/first.png' },
    safeDependencies({
      async fetch() {
        fetchCalls += 1
        return redirected.response
      },
      async lookup() {
        lookupCalls += 1
        return [{
          address: lookupCalls === 1 ? '93.184.216.34' : '10.0.0.9',
          family: 4,
        }]
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_DNS_UNSAFE', ['rebind-secret'])
  assert.equal(lookupCalls, 2)
  assert.equal(fetchCalls, 1)
  assert.equal(redirected.state.cancelled, true)

  const credentialRedirect = response({
    status: 302,
    headers: {
      location: 'https://user:redirect-password@cdn.vendor.com/image.png',
    },
    chunks: [],
  })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/first.png' },
    safeDependencies({ fetch: async () => credentialRedirect.response }),
  ), 'COMMERCE_PROVIDER_IMAGE_CREDENTIALS_FORBIDDEN', [
    'user',
    'redirect-password',
    'cdn.vendor.com',
  ])
  assert.equal(credentialRedirect.state.cancelled, true)
})

test('enforces the redirect limit and requires a valid redirect location', async () => {
  let fetchCalls = 0
  const dependencies = safeDependencies({
    async fetch() {
      fetchCalls += 1
      return response({
        status: 301,
        headers: { location: `/redirect-${fetchCalls}.png` },
        chunks: [],
      }).response
    },
  })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/start.png' },
    dependencies,
  ), 'COMMERCE_PROVIDER_IMAGE_REDIRECT_LIMIT')
  assert.equal(fetchCalls, COMMERCE_PROVIDER_IMAGE_MAX_REDIRECTS + 1)

  const missing = response({ status: 302, chunks: [] })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/start.png' },
    safeDependencies({ fetch: async () => missing.response }),
  ), 'COMMERCE_PROVIDER_IMAGE_REDIRECT_INVALID')
  assert.equal(missing.state.cancelled, true)
})

test('enforces the streamed 16 MiB source cap without trusting Content-Length', async () => {
  const oversized = response({
    headers: { 'content-type': 'image/png' },
    chunks: [
      new Uint8Array(COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES),
      Uint8Array.of(0),
    ],
  })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/oversized.png' },
    safeDependencies({ fetch: async () => oversized.response }),
  ), 'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID')
  assert.equal(oversized.state.cancelled, true)
})

test('normalizes a fully decoded oversized source and retains source evidence', async () => {
  const width = 1_600
  const height = 1_600
  const pixels = Buffer.alloc(width * height * 3)
  let random = 0x12345678
  for (let index = 0; index < pixels.byteLength; index += 1) {
    random = ((random * 1_664_525) + 1_013_904_223) >>> 0
    pixels[index] = random >>> 24
  }
  const source = await sharpModule(pixels, {
    raw: { channels: 3, height, width },
  }).png({ compressionLevel: 0 }).toBuffer()
  assert.ok(source.byteLength > CRM_PRODUCT_IMAGE_MAX_BYTES)
  assert.ok(source.byteLength < COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES)

  const result = await fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/oversized-valid.png' },
    safeDependencies({
      async fetch() {
        return response({
          chunks: [source],
          headers: {
            'content-length': String(source.byteLength),
            'content-type': 'image/png',
          },
        }).response
      },
    }),
  )
  assert.ok(result.byteLength <= CRM_PRODUCT_IMAGE_MAX_BYTES)
  assert.equal(result.mediaType, 'image/webp')
  assert.match(
    result.normalizationVersion,
    /^sharp-0\.35\.3-webp-auto-orient-v1-q\d+$/,
  )
  assert.equal(result.pixelWidth, width)
  assert.equal(result.pixelHeight, height)
  assert.equal(result.sourceByteLength, source.byteLength)
  assert.equal(result.sourceContentSha256, createHash('sha256')
    .update(source).digest('hex'))
  assert.notEqual(result.contentSha256, result.sourceContentSha256)
  assert.deepEqual(await sharpModule(result.bytes).metadata().then((metadata) => ({
    format: metadata.format,
    height: metadata.height,
    width: metadata.width,
  })), { format: 'webp', height, width })
})

test('auto-orients an oversized JPEG before stripping EXIF metadata', async () => {
  const width = 1_400
  const height = 1_200
  const pixels = Buffer.alloc(width * height * 3)
  let random = 0x9abcdef0
  for (let index = 0; index < pixels.byteLength; index += 1) {
    random = ((random * 1_664_525) + 1_013_904_223) >>> 0
    pixels[index] = random >>> 24
  }
  const source = await sharpModule(pixels, {
    raw: { channels: 3, height, width },
  }).jpeg({
    chromaSubsampling: '4:4:4',
    quality: 100,
  }).withMetadata({ orientation: 6 }).toBuffer()
  assert.ok(source.byteLength > CRM_PRODUCT_IMAGE_MAX_BYTES)

  const result = await fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/oriented-oversized.jpg' },
    safeDependencies({
      async fetch() {
        return response({
          chunks: [source],
          headers: {
            'content-length': String(source.byteLength),
            'content-type': 'image/jpeg',
          },
        }).response
      },
    }),
  )
  assert.equal(result.mediaType, 'image/webp')
  assert.equal(result.pixelWidth, height)
  assert.equal(result.pixelHeight, width)
  const metadata = await sharpModule(result.bytes).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, height)
  assert.equal(metadata.height, width)
  assert.equal(metadata.orientation, undefined)
})

test('uses bounded storage for thousands of tiny chunks and rejects empty chunks', async () => {
  const image = pngWithAncillaryPayload(4_096)
  const chunks = Array.from(image, (byte) => Uint8Array.of(byte))
  assert.ok(chunks.length > 4_000)
  const result = await fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/fragmented.png' },
    safeDependencies({
      async fetch() {
        return response({
          chunks,
          headers: {
            'content-length': String(image.byteLength),
            'content-type': 'image/png',
          },
        }).response
      },
    }),
  )
  assert.equal(result.byteLength, image.byteLength)
  assert.equal(result.pixelWidth, 1)
  assert.equal(result.pixelHeight, 1)

  const empty = response({
    chunks: [new Uint8Array(0), ONE_PIXEL_PNG],
    headers: { 'content-type': 'image/png' },
  })
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/empty-chunk.png' },
    safeDependencies({ fetch: async () => empty.response }),
  ), 'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID')
  assert.equal(empty.state.cancelled, true)
})

test('fails closed on oversized, malformed, and mismatched Content-Length', async () => {
  for (const [contentLength, expectedCode] of [
    [String(COMMERCE_PROVIDER_IMAGE_SOURCE_MAX_BYTES + 1), 'COMMERCE_PROVIDER_IMAGE_SIZE_INVALID'],
    ['1.5', 'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID'],
    [String(ONE_PIXEL_PNG.byteLength + 1), 'COMMERCE_PROVIDER_IMAGE_CONTENT_LENGTH_INVALID'],
  ]) {
    const fetched = response({
      headers: {
        'content-length': contentLength,
        'content-type': 'image/png',
      },
    })
    await expectCode(fetchCommerceProviderImage(
      { url: 'https://images.vendor.com/image.png' },
      safeDependencies({ fetch: async () => fetched.response }),
    ), expectedCode)
    assert.equal(fetched.state.cancelled, true)
  }
})

test('aborts stalled transport and body reads on a deterministic timeout', async () => {
  let fireTimeout = () => assert.fail('timeout was not scheduled')
  let fetchSignal
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/stalled.png', timeoutMs: 25 },
    safeDependencies({
      async fetch(request) {
        fetchSignal = request.signal
        fireTimeout()
        return new Promise(() => {})
      },
      scheduleTimeout(callback, delayMs) {
        assert.equal(delayMs, 25)
        fireTimeout = callback
        return Symbol('timeout')
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_TIMEOUT')
  assert.equal(fetchSignal.aborted, true)

  fireTimeout = () => assert.fail('body timeout was not scheduled')
  const stalledBody = response({
    headers: { 'content-type': 'image/png' },
    chunks: [],
  })
  stalledBody.response.body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          fireTimeout()
          return new Promise(() => {})
        },
        async return() {
          return { done: true }
        },
      }
    },
  }
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/stalled-body.png', timeoutMs: 30 },
    safeDependencies({
      fetch: async () => stalledBody.response,
      scheduleTimeout(callback, delayMs) {
        assert.equal(delayMs, 30)
        fireTimeout = callback
        return Symbol('timeout')
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_TIMEOUT')
  assert.equal(stalledBody.state.cancelled, true)
})

test('distinguishes caller abort from timeout and enforces the total deadline', async () => {
  const caller = new AbortController()
  caller.abort()
  await expectCode(fetchCommerceProviderImage(
    {
      signal: caller.signal,
      url: 'https://images.vendor.com/image.png',
    },
    safeDependencies(),
  ), 'COMMERCE_PROVIDER_IMAGE_ABORTED')

  let clockCalls = 0
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/image.png', timeoutMs: 15 },
    safeDependencies({
      now() {
        clockCalls += 1
        return clockCalls === 1 ? 0 : 15
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_TIMEOUT')
})

test('rejects unsuccessful status, unsupported MIME, mismatch, corruption, and dimension bombs', async () => {
  const cases = [
    {
      code: 'COMMERCE_PROVIDER_IMAGE_STATUS_INVALID',
      fetched: response({ status: 404, chunks: [] }),
    },
    {
      code: 'COMMERCE_PROVIDER_IMAGE_MIME_UNSUPPORTED',
      fetched: response({ headers: { 'content-type': 'image/gif' } }),
    },
    {
      code: 'COMMERCE_PROVIDER_IMAGE_MIME_MISMATCH',
      fetched: response({ headers: { 'content-type': 'image/jpeg' } }),
    },
    {
      code: 'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID',
      fetched: response({
        chunks: [Uint8Array.from({ length: 64 }, (_, index) => index)],
        headers: { 'content-type': 'image/png' },
      }),
    },
    {
      code: 'COMMERCE_PROVIDER_IMAGE_DIMENSIONS_INVALID',
      fetched: response({
        chunks: [losslessWebpFixture(8192, 8192)],
        headers: { 'content-type': 'image/webp' },
      }),
    },
  ]
  for (const { code, fetched } of cases) {
    await expectCode(fetchCommerceProviderImage(
      { url: 'https://images.vendor.com/image.png' },
      safeDependencies({ fetch: async () => fetched.response }),
    ), code)
  }

  const corruptPng = Uint8Array.from(ONE_PIXEL_PNG)
  corruptPng[45] = corruptPng[45] ^ 0x01
  await expectCode(fetchCommerceProviderImage(
    { url: 'https://images.vendor.com/corrupt.png' },
    safeDependencies({
      fetch: async () => response({
        chunks: [corruptPng],
        headers: { 'content-type': 'image/png' },
      }).response,
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID')
})

test('fully decodes compressed pixels before accepting structurally plausible images', async () => {
  for (const [mediaType, bytes] of [
    ['image/webp', losslessWebpFixture(4, 5)],
    ['image/png', pngWithInvalidCompressedData()],
    ['image/jpeg', STRUCTURAL_ONLY_JPEG],
  ]) {
    const structurallyValid = productImageAssets.validateCrmProductImage({
      altText: 'Structural validation control',
      bytes,
      declaredMimeType: mediaType,
    })
    assert.ok(structurallyValid.pixelWidth > 0)
    assert.ok(structurallyValid.pixelHeight > 0)
    const fetched = response({
      chunks: [bytes],
      headers: { 'content-type': mediaType },
    })
    await expectCode(fetchCommerceProviderImage(
      { url: `https://images.vendor.com/malformed.${mediaType.split('/')[1]}` },
      safeDependencies({ fetch: async () => fetched.response }),
    ), 'COMMERCE_PROVIDER_IMAGE_CONTENT_INVALID')
  }
})

test('sanitizes transport failures without leaking URL, query, or provider detail', async () => {
  const secretUrl = 'https://images.vendor.com/image.png?token=transport-secret'
  await expectCode(fetchCommerceProviderImage(
    { url: secretUrl },
    safeDependencies({
      async fetch() {
        throw new Error(`socket failed for ${secretUrl}`)
      },
    }),
  ), 'COMMERCE_PROVIDER_IMAGE_FETCH_FAILED', [
    secretUrl,
    'transport-secret',
    'images.vendor.com',
  ])
})
