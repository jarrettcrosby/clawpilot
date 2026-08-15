#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PrintAgentReleaseError,
  validateGitHubAssetRedirect,
  validateGitHubContentsReadTokenResponse,
  verifyPrintAgentRelease,
} from '../app_src/lib/operations/printAgentRelease.mjs'

const root = process.cwd()
const sourceCommit = 'a'.repeat(40)
const version = '0.1.0'
const tag = `print-gateway-v${version}`
const repositoryId = '123456789'
const nowMs = Date.parse('2026-08-15T16:00:00.000Z')
const signedLocation = `https://release-assets.githubusercontent.com/github-production-release-asset/test/index?se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}&sig=test`

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function artifact(platform) {
  const macos = platform === 'macos'
  const bytes = Buffer.from(macos ? 'signed notarized stapled dmg' : 'signed windows executable')
  return {
    schemaVersion: 1,
    product: 'ClawPilot Print Agent',
    version,
    sourceCommit,
    platform,
    architecture: macos ? 'universal' : 'x64',
    filename: `ClawPilot-Print-Agent-${version}-${macos ? 'mac-universal.dmg' : 'win-x64.exe'}`,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    signed: true,
    notarized: macos,
    stapled: macos,
    customerReleaseReady: true,
    credentialEmbedded: false,
    printerEndpointEmbedded: false,
    deliveryBackend: 'raw-network-zpl',
    manifestSignature: 'sigstore-bundle-required-before-publish',
  }
}

function uploadedAsset(id, name, bytes = Buffer.from(name)) {
  return {
    id,
    name,
    state: 'uploaded',
    size: bytes.length,
    digest: `sha256:${sha256(bytes)}`,
  }
}

function fixture(mutateIndex) {
  const index = {
    schemaVersion: 1,
    product: 'ClawPilot Print Agent',
    version,
    sourceCommit,
    customerReleaseReady: true,
    artifacts: [artifact('macos'), artifact('windows')],
    signature: 'sigstore-bundle-required-before-publish',
  }
  mutateIndex?.(index)
  const indexBytes = Buffer.from(JSON.stringify(index))
  const indexDigest = sha256(indexBytes)
  const indexFilename = `ClawPilot-Print-Agent-${version}-release.json`
  let nextAssetId = 10
  const assets = [uploadedAsset(nextAssetId++, indexFilename, indexBytes)]
  for (const item of index.artifacts.filter((candidate) => candidate && typeof candidate === 'object')) {
    const binaryBytes = Buffer.alloc(item.byteLength, item.platform === 'macos' ? 'm' : 'w')
    assets.push({
      ...uploadedAsset(nextAssetId++, item.filename, binaryBytes),
      digest: `sha256:${item.sha256}`,
    })
    for (const suffix of [
      '.artifact.json',
      '.artifact.json.sigstore.json',
      '.sha256',
      '.sha256.sigstore.json',
    ]) {
      assets.push(uploadedAsset(nextAssetId++, `${item.filename}${suffix}`))
    }
  }
  assets.push(
    uploadedAsset(nextAssetId++, `${indexFilename}.sigstore.json`),
    uploadedAsset(nextAssetId++, 'SHA256SUMS.txt'),
    uploadedAsset(nextAssetId++, 'SHA256SUMS.txt.sigstore.json'),
  )
  return {
    indexBytes,
    configuration: {
      repository: 'jarrettcrosby/clawpilot',
      repositoryId,
      version,
      tag,
      sourceCommit,
      indexFilename,
      indexSha256: indexDigest,
      prerelease: false,
    },
    repository: { id: Number(repositoryId), full_name: 'jarrettcrosby/clawpilot', private: true },
    release: {
      tag_name: tag,
      target_commitish: sourceCommit,
      draft: false,
      prerelease: false,
      immutable: true,
      assets,
    },
    ref: { object: { type: 'commit', sha: sourceCommit } },
    compare: { status: 'ahead', merge_base_commit: { sha: sourceCommit } },
  }
}

const state = { current: fixture() }
const requestLog = []
const server = http.createServer((request, response) => {
  requestLog.push({ url: request.url, accept: request.headers.accept })
  const active = state.current
  let status = 200
  let payload
  if (request.url === '/repos/jarrettcrosby/clawpilot') payload = active.repository
  else if (request.url === `/repos/jarrettcrosby/clawpilot/releases/tags/${tag}`) payload = active.release
  else if (request.url === `/repos/jarrettcrosby/clawpilot/git/ref/tags/${tag}`) payload = active.ref
  else if (request.url === `/repos/jarrettcrosby/clawpilot/compare/${sourceCommit}...main`) payload = active.compare
  else if (request.url === '/repos/jarrettcrosby/clawpilot/releases/assets/10') {
    response.writeHead(302, { Location: active.indexLocation || signedLocation })
    response.end()
    return
  } else {
    status = 404
    payload = { message: 'not found' }
  }
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
})

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
const address = server.address()
assert.ok(address && typeof address === 'object')
const origin = `http://127.0.0.1:${address.port}`

async function verify(active = fixture(), downloadOverride) {
  state.current = active
  return verifyPrintAgentRelease({
    configuration: active.configuration,
    nowMs,
    request: ({ path, accept, redirect }) => fetch(`${origin}${path}`, {
      headers: { Accept: accept },
      redirect: redirect || 'manual',
    }),
    download: downloadOverride || (async (location) => {
      assert.equal(location, signedLocation)
      return new Response(active.indexBytes, { status: 200 })
    }),
  })
}

async function expectCode(code, callback) {
  await assert.rejects(callback, (error) => error instanceof PrintAgentReleaseError && error.code === code)
}

try {
  const verified = await verify()
  assert.equal(verified.version, version)
  assert.equal(verified.customerReleaseReady, true)
  assert.deepEqual(verified.artifacts.map(({ platform, architecture }) => `${platform}:${architecture}`).sort(), [
    'macos:universal',
    'windows:x64',
  ])
  assert.ok(requestLog.some((entry) => entry.url === '/repos/jarrettcrosby/clawpilot/releases/assets/10' && entry.accept === 'application/octet-stream'))

  const streamedIndex = fixture()
  const streamedVerified = await verifyPrintAgentRelease({
    configuration: streamedIndex.configuration,
    nowMs,
    request: async ({ path, accept, redirect }) => {
      if (path === '/repos/jarrettcrosby/clawpilot/releases/assets/10') {
        return new Response(streamedIndex.indexBytes, { status: 200 })
      }
      return fetch(`${origin}${path}`, { headers: { Accept: accept }, redirect: redirect || 'manual' })
    },
  })
  assert.equal(streamedVerified.version, version)

  const repoDrift = fixture()
  repoDrift.repository.id += 1
  await expectCode('PRINT_AGENT_RELEASE_REPOSITORY_INVALID', () => verify(repoDrift))

  for (const [field, value] of [['draft', true], ['prerelease', true], ['target_commitish', 'b'.repeat(40)]]) {
    const drift = fixture()
    drift.release[field] = value
    await expectCode('PRINT_AGENT_RELEASE_INVALID', () => verify(drift))
  }

  const releaseWithoutApiImmutability = fixture()
  releaseWithoutApiImmutability.release.immutable = false
  assert.equal((await verify(releaseWithoutApiImmutability)).version, version)

  const tagDrift = fixture()
  tagDrift.ref.object.sha = 'b'.repeat(40)
  await expectCode('PRINT_AGENT_RELEASE_SOURCE_INVALID', () => verify(tagDrift))

  const ancestryDrift = fixture()
  ancestryDrift.compare.merge_base_commit.sha = 'b'.repeat(40)
  await expectCode('PRINT_AGENT_RELEASE_SOURCE_INVALID', () => verify(ancestryDrift))

  const digestDrift = fixture()
  digestDrift.release.assets[0].digest = `sha256:${'0'.repeat(64)}`
  await expectCode('PRINT_AGENT_RELEASE_INDEX_INVALID', () => verify(digestDrift))

  await expectCode('PRINT_AGENT_RELEASE_INDEX_INVALID', () => verify(fixture((index) => { index.endpoint = 'https://example.test' })))
  await expectCode('PRINT_AGENT_RELEASE_INDEX_INVALID', () => verify(fixture((index) => { index.artifacts[0].notarized = false })))
  await expectCode('PRINT_AGENT_RELEASE_INDEX_INVALID', () => verify(fixture((index) => { index.artifacts[1].signed = false })))

  const assetDrift = fixture()
  assetDrift.release.assets[1].size += 1
  await expectCode('PRINT_AGENT_RELEASE_ASSET_INVALID', () => verify(assetDrift))

  const extraAsset = fixture()
  extraAsset.release.assets.push({ id: 99, name: 'unexpected.txt', state: 'uploaded', size: 1, digest: `sha256:${'0'.repeat(64)}` })
  await expectCode('PRINT_AGENT_RELEASE_ASSET_INVALID', () => verify(extraAsset))

  await expectCode('PRINT_AGENT_RELEASE_INDEX_INVALID', () => verify(fixture(), async () => (
    new Response(null, { status: 302, headers: { Location: signedLocation } })
  )))

  assert.equal(validateGitHubAssetRedirect(signedLocation, nowMs), signedLocation)
  for (const evil of [
    `http://release-assets.githubusercontent.com/file?se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}`,
    `https://release-assets.githubusercontent.com:444/file?se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}`,
    `https://evil.example/file?se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}`,
    `https://release-assets.githubusercontent.com/file?token=leak&se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}`,
    `https://release-assets.githubusercontent.com/file?se=${encodeURIComponent('2026-08-15T16:05:00.000Z')}`,
    `https://release-assets.githubusercontent.com/file?se=${encodeURIComponent('2026-08-15T15:59:00.000Z')}&sig=test`,
    `https://release-assets.githubusercontent.com/file?se=${encodeURIComponent('2026-08-15T17:00:00.000Z')}&sig=test`,
  ]) {
    assert.throws(() => validateGitHubAssetRedirect(evil, nowMs), (error) => (
      error instanceof PrintAgentReleaseError && error.code === 'PRINT_AGENT_RELEASE_REDIRECT_INVALID'
    ))
  }

  const validCredential = {
    token: 'installation-token',
    expires_at: '2026-08-15T17:00:00.000Z',
    permissions: { contents: 'read', metadata: 'read' },
    repositories: [{ id: Number(repositoryId), full_name: 'jarrettcrosby/clawpilot' }],
  }
  assert.equal(validateGitHubContentsReadTokenResponse(validCredential, {
    repositoryId,
    repositoryFullName: 'jarrettcrosby/clawpilot',
  }).token, 'installation-token')
  for (const permissions of [
    { metadata: 'read' },
    { contents: 'write', metadata: 'read' },
    { actions: 'write', contents: 'read', metadata: 'read' },
  ]) {
    assert.throws(() => validateGitHubContentsReadTokenResponse({ ...validCredential, permissions }, {
      repositoryId,
      repositoryFullName: 'jarrettcrosby/clawpilot',
    }), (error) => error instanceof PrintAgentReleaseError && error.code === 'PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID')
  }

  const githubSource = readFileSync(resolve(root, 'app_src/lib/githubApp.ts'), 'utf8')
  const credentialStart = githubSource.indexOf('export async function createGitHubContentsReadInstallationToken')
  const credentialEnd = githubSource.indexOf('export async function githubContentsReadRequest')
  const credentialSource = githubSource.slice(credentialStart, credentialEnd)
  assert.ok(credentialSource.includes("permissions: { contents: 'read', metadata: 'read' }"))
  assert.ok(!credentialSource.includes('actions'))

  const metadataRoute = readFileSync(resolve(root, 'app_src/app/api/operations/print-agent/releases/route.ts'), 'utf8')
  const downloadRoute = readFileSync(resolve(root, 'app_src/app/api/operations/print-agent/releases/download/route.ts'), 'utf8')
  for (const route of [metadataRoute, downloadRoute]) {
    assert.ok(route.includes('requireRequestUser(req)'))
    assert.ok(route.includes("requireOperationsCapability(actor, 'canView')"))
    assert.ok(route.includes('activeOperationsOrganizationId(actor)'))
    assert.ok(route.includes("'Cache-Control': 'private, no-store'"))
    assert.ok(route.includes("'Referrer-Policy': 'no-referrer'"))
    assert.ok(!route.includes('credential.token'))
  }
  assert.ok(downloadRoute.includes('status: 307'))
  assert.ok(!metadataRoute.includes('sourceCommit: release.sourceCommit'))
  assert.ok(!metadataRoute.includes('releaseIndexSha256: release.releaseIndexSha256'))

  const healthRoute = readFileSync(resolve(root, 'app_src/app/api/health/route.ts'), 'utf8')
  const runtimeValidator = readFileSync(resolve(root, 'scripts/validate-runtime-config.mjs'), 'utf8')
  const predeploy = readFileSync(resolve(root, 'scripts/verify-predeploy.mjs'), 'utf8')
  assert.ok(healthRoute.includes('getPrintAgentReleaseConfiguration'))
  assert.ok(healthRoute.includes('printAgentRelease.enabled && !printAgentRelease.ready'))
  assert.ok(runtimeValidator.includes('CLAWPILOT_PRINT_AGENT_RELEASE_INDEX_SHA256'))
  assert.ok(predeploy.includes("run(process.execPath, ['scripts/test-print-agent-release-download.mjs'])"))

  console.log('print-agent release download contract tests passed')
} finally {
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
}
