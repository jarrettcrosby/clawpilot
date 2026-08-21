import crypto from 'node:crypto'

const REPOSITORY = 'jarrettcrosby/clawpilot'
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_INDEX_BYTES = 128 * 1024
const TOP_LEVEL_FIELDS = [
  'artifacts',
  'customerReleaseReady',
  'product',
  'schemaVersion',
  'signature',
  'sourceCommit',
  'version',
]
const ARTIFACT_FIELDS = [
  'architecture',
  'byteLength',
  'credentialEmbedded',
  'customerReleaseReady',
  'deliveryBackend',
  'filename',
  'manifestSignature',
  'notarized',
  'platform',
  'printerEndpointEmbedded',
  'product',
  'schemaVersion',
  'sha256',
  'signed',
  'sourceCommit',
  'stapled',
  'version',
]

export class PrintAgentReleaseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PrintAgentReleaseError'
    this.code = code
  }
}

export function validateGitHubContentsReadTokenResponse(payloadValue, configuration) {
  const payload = record(
    payloadValue,
    'PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID',
    'GitHub returned an invalid installation credential',
  )
  const permissions = record(
    payload.permissions,
    'PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID',
    'GitHub installation credential permissions are invalid',
  )
  const permissionNames = Object.keys(permissions).sort()
  if (permissionNames.length !== 2
    || permissionNames[0] !== 'contents'
    || permissionNames[1] !== 'metadata'
    || permissions.contents !== 'read'
    || permissions.metadata !== 'read') {
    fail('PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID', 'GitHub installation credential is not contents-read only')
  }
  if (!Array.isArray(payload.repositories) || payload.repositories.length !== 1) {
    fail('PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID', 'GitHub installation credential repository scope is invalid')
  }
  const repository = record(
    payload.repositories[0],
    'PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID',
    'GitHub installation credential repository scope is invalid',
  )
  if (String(repository.id || '') !== String(configuration.repositoryId)
    || repository.full_name !== configuration.repositoryFullName) {
    fail('PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID', 'GitHub installation credential repository scope drifted')
  }
  const token = String(payload.token || '').trim()
  const expiresAt = String(payload.expires_at || '').trim()
  if (!token || !Number.isFinite(Date.parse(expiresAt))) {
    fail('PRINT_AGENT_RELEASE_GITHUB_CREDENTIAL_INVALID', 'GitHub returned an incomplete installation credential')
  }
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

function fail(code, message) {
  throw new PrintAgentReleaseError(code, message)
}

function record(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message)
  return value
}

function exactFields(value, expected, code) {
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(code, 'Release metadata contains unsupported or missing fields')
  }
}

async function jsonResponse(response, code, message) {
  if (!response.ok) fail(code, `${message} (HTTP ${response.status})`)
  try {
    return record(await response.json(), code, message)
  } catch {
    fail(code, message)
  }
}

async function requestJson(request, path, code, message) {
  return jsonResponse(await request({ path, accept: 'application/vnd.github+json' }), code, message)
}

function releaseAsset(value) {
  const asset = record(value, 'PRINT_AGENT_RELEASE_ASSET_INVALID', 'GitHub returned invalid release asset metadata')
  const id = Number(asset.id)
  const name = String(asset.name || '')
  const size = Number(asset.size)
  const digest = String(asset.digest || '').toLowerCase()
  if (!Number.isSafeInteger(id) || id < 1 || !name || !Number.isSafeInteger(size) || size < 1 || asset.state !== 'uploaded') {
    fail('PRINT_AGENT_RELEASE_ASSET_INVALID', 'GitHub returned invalid release asset metadata')
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    fail('PRINT_AGENT_RELEASE_ASSET_INVALID', 'GitHub release asset digest is unavailable or invalid')
  }
  return { id, name, size, digest }
}

function expectedArtifact(configuration, platform) {
  const suffix = platform === 'macos' ? 'mac-universal.dmg' : 'win-x64.exe'
  return `ClawPilot-Print-Agent-${configuration.version}-${suffix}`
}

function validateIndex(configuration, value) {
  const index = record(value, 'PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index is invalid')
  exactFields(index, TOP_LEVEL_FIELDS, 'PRINT_AGENT_RELEASE_INDEX_INVALID')
  if (index.schemaVersion !== 1
    || index.product !== 'ClawPilot Print Agent'
    || index.version !== configuration.version
    || index.sourceCommit !== configuration.sourceCommit
    || index.customerReleaseReady !== true
    || index.signature !== 'sigstore-bundle-required-before-publish'
    || !Array.isArray(index.artifacts)
    || index.artifacts.length !== 2) {
    fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index does not match the configured customer release')
  }

  const expectedPairs = new Map([
    ['macos:universal', { notarized: true, stapled: true }],
    ['windows:x64', { notarized: false, stapled: false }],
  ])
  const artifacts = index.artifacts.map((candidate) => {
    const artifact = record(candidate, 'PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release artifact is invalid')
    exactFields(artifact, ARTIFACT_FIELDS, 'PRINT_AGENT_RELEASE_INDEX_INVALID')
    const platform = String(artifact.platform || '')
    const architecture = String(artifact.architecture || '')
    const pair = `${platform}:${architecture}`
    const expected = expectedPairs.get(pair)
    if (!expected) fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index contains an unsupported artifact')
    expectedPairs.delete(pair)
    const byteLength = Number(artifact.byteLength)
    const sha256 = String(artifact.sha256 || '').toLowerCase()
    if (artifact.schemaVersion !== 1
      || artifact.product !== 'ClawPilot Print Agent'
      || artifact.version !== configuration.version
      || artifact.sourceCommit !== configuration.sourceCommit
      || artifact.filename !== expectedArtifact(configuration, platform)
      || !Number.isSafeInteger(byteLength)
      || byteLength < 1
      || !SHA256.test(sha256)
      || artifact.sha256 !== sha256
      || artifact.signed !== true
      || artifact.notarized !== expected.notarized
      || artifact.stapled !== expected.stapled
      || artifact.customerReleaseReady !== true
      || artifact.credentialEmbedded !== false
      || artifact.printerEndpointEmbedded !== false
      || artifact.deliveryBackend !== 'raw-network-zpl'
      || artifact.manifestSignature !== 'sigstore-bundle-required-before-publish') {
      fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release artifact is not customer-ready or does not match the configured contract')
    }
    return {
      platform,
      architecture,
      filename: artifact.filename,
      byteLength,
      sha256,
      signed: true,
      notarized: expected.notarized,
      stapled: expected.stapled,
      customerReleaseReady: true,
    }
  })
  if (expectedPairs.size) fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index is missing a required artifact')
  return { index, artifacts }
}

async function resolveTagCommit(request, tag) {
  const ref = await requestJson(
    request,
    `/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    'PRINT_AGENT_RELEASE_TAG_INVALID',
    'Unable to resolve print-agent release tag',
  )
  const object = record(ref.object, 'PRINT_AGENT_RELEASE_TAG_INVALID', 'Print-agent release tag is invalid')
  let sha = String(object.sha || '').toLowerCase()
  if (!COMMIT.test(sha)) fail('PRINT_AGENT_RELEASE_TAG_INVALID', 'Print-agent release tag is invalid')
  if (object.type === 'tag') {
    const tagObject = await requestJson(
      request,
      `/repos/${REPOSITORY}/git/tags/${sha}`,
      'PRINT_AGENT_RELEASE_TAG_INVALID',
      'Unable to resolve annotated print-agent release tag',
    )
    const target = record(tagObject.object, 'PRINT_AGENT_RELEASE_TAG_INVALID', 'Annotated print-agent release tag is invalid')
    if (target.type !== 'commit') fail('PRINT_AGENT_RELEASE_TAG_INVALID', 'Annotated print-agent release tag does not target a commit')
    sha = String(target.sha || '').toLowerCase()
  } else if (object.type !== 'commit') {
    fail('PRINT_AGENT_RELEASE_TAG_INVALID', 'Print-agent release tag does not target a commit')
  }
  if (!COMMIT.test(sha)) fail('PRINT_AGENT_RELEASE_TAG_INVALID', 'Print-agent release tag commit is invalid')
  return sha
}

export async function verifyPrintAgentRelease({ configuration, request, download, nowMs = Date.now() }) {
  if (!configuration || configuration.repository !== REPOSITORY) {
    fail('PRINT_AGENT_RELEASE_CONFIGURATION_INVALID', 'Print-agent release repository is invalid')
  }
  const repository = await requestJson(
    request,
    `/repos/${REPOSITORY}`,
    'PRINT_AGENT_RELEASE_REPOSITORY_INVALID',
    'Unable to verify print-agent release repository',
  )
  if (String(repository.id || '') !== String(configuration.repositoryId)
    || repository.full_name !== REPOSITORY
    || repository.private !== true) {
    fail('PRINT_AGENT_RELEASE_REPOSITORY_INVALID', 'Print-agent release repository identity changed')
  }

  const release = await requestJson(
    request,
    `/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(configuration.tag)}`,
    'PRINT_AGENT_RELEASE_INVALID',
    'Unable to resolve configured print-agent release',
  )
  if (release.tag_name !== configuration.tag
    || String(release.target_commitish || '').toLowerCase() !== configuration.sourceCommit
    || release.draft !== false
    || release.prerelease !== configuration.prerelease
    || !Array.isArray(release.assets)) {
    fail('PRINT_AGENT_RELEASE_INVALID', 'Configured print-agent release is unpublished or drifted')
  }
  const tagCommit = await resolveTagCommit(request, configuration.tag)
  if (tagCommit !== configuration.sourceCommit) {
    fail('PRINT_AGENT_RELEASE_SOURCE_INVALID', 'Print-agent release tag does not match the configured source commit')
  }

  const ancestry = await requestJson(
    request,
    `/repos/${REPOSITORY}/compare/${configuration.sourceCommit}...main`,
    'PRINT_AGENT_RELEASE_SOURCE_INVALID',
    'Unable to verify print-agent release source ancestry',
  )
  const mergeBase = record(ancestry.merge_base_commit, 'PRINT_AGENT_RELEASE_SOURCE_INVALID', 'Print-agent release source ancestry is invalid')
  if (String(mergeBase.sha || '').toLowerCase() !== configuration.sourceCommit
    || !['identical', 'ahead'].includes(String(ancestry.status || ''))) {
    fail('PRINT_AGENT_RELEASE_SOURCE_INVALID', 'Print-agent release source commit is not reachable from main')
  }

  const githubAssets = release.assets.map(releaseAsset)
  if (new Set(githubAssets.map((asset) => asset.name)).size !== githubAssets.length) {
    fail('PRINT_AGENT_RELEASE_ASSET_INVALID', 'Print-agent release contains duplicate asset names')
  }
  const indexAsset = githubAssets.find((asset) => asset.name === configuration.indexFilename)
  if (!indexAsset
    || indexAsset.digest !== `sha256:${configuration.indexSha256}`
    || indexAsset.size > MAX_INDEX_BYTES) {
    fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Configured release index asset is missing or drifted')
  }
  const indexResponse = await request({
    path: `/repos/${REPOSITORY}/releases/assets/${indexAsset.id}`,
    accept: 'application/octet-stream',
    redirect: 'manual',
  })
  let indexDownload = indexResponse
  if ([302, 303].includes(indexResponse.status)) {
    if (!download) fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index downloader is unavailable')
    const indexLocation = validateGitHubAssetRedirect(indexResponse.headers.get('location') || '', nowMs)
    indexDownload = await download(indexLocation)
  }
  if (!indexDownload.ok || indexDownload.redirected) {
    fail('PRINT_AGENT_RELEASE_INDEX_INVALID', `Unable to fetch release index (HTTP ${indexDownload.status})`)
  }
  const indexBytes = Buffer.from(await indexDownload.arrayBuffer())
  if (indexBytes.length !== indexAsset.size || indexBytes.length > MAX_INDEX_BYTES) {
    fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index byte length drifted')
  }
  const indexSha256 = crypto.createHash('sha256').update(indexBytes).digest('hex')
  if (indexSha256 !== configuration.indexSha256) fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index digest drifted')
  let parsedIndex
  try {
    parsedIndex = JSON.parse(indexBytes.toString('utf8'))
  } catch {
    fail('PRINT_AGENT_RELEASE_INDEX_INVALID', 'Release index is not valid JSON')
  }
  const { artifacts } = validateIndex(configuration, parsedIndex)
  const expectedAssetNames = new Set([
    configuration.indexFilename,
    `${configuration.indexFilename}.sigstore.json`,
    'SHA256SUMS.txt',
    'SHA256SUMS.txt.sigstore.json',
    ...artifacts.flatMap((artifact) => [
      artifact.filename,
      `${artifact.filename}.artifact.json`,
      `${artifact.filename}.artifact.json.sigstore.json`,
      `${artifact.filename}.sha256`,
      `${artifact.filename}.sha256.sigstore.json`,
    ]),
  ])
  if (githubAssets.length !== expectedAssetNames.size
    || githubAssets.some((asset) => !expectedAssetNames.has(asset.name))) {
    fail('PRINT_AGENT_RELEASE_ASSET_INVALID', 'Release asset set drifted from the verified release index')
  }
  const verifiedArtifacts = artifacts.map((artifact) => {
    const asset = githubAssets.find((candidate) => candidate.name === artifact.filename)
    if (!asset
      || asset.size !== artifact.byteLength
      || asset.digest !== `sha256:${artifact.sha256}`) {
      fail('PRINT_AGENT_RELEASE_ASSET_INVALID', 'Release binary asset is missing or drifted')
    }
    return { ...artifact, assetId: asset.id }
  })

  return {
    schemaVersion: 1,
    product: 'ClawPilot Print Agent',
    version: configuration.version,
    tag: configuration.tag,
    sourceCommit: configuration.sourceCommit,
    customerReleaseReady: true,
    releaseIndexSha256: configuration.indexSha256,
    artifacts: verifiedArtifacts,
  }
}

export function validateGitHubAssetRedirect(location, nowMs = Date.now()) {
  let parsed
  try {
    parsed = new URL(location)
  } catch {
    fail('PRINT_AGENT_RELEASE_REDIRECT_INVALID', 'GitHub returned an invalid asset redirect')
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== '443')
    || parsed.hash
    || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) {
    fail('PRINT_AGENT_RELEASE_REDIRECT_INVALID', 'GitHub returned an untrusted asset redirect')
  }
  const prohibited = ['access_token', 'authorization', 'token']
  for (const key of parsed.searchParams.keys()) {
    if (prohibited.includes(key.toLowerCase())) {
      fail('PRINT_AGENT_RELEASE_REDIRECT_INVALID', 'GitHub asset redirect exposed a credential')
    }
  }
  if (!parsed.searchParams.get('sig') && !parsed.searchParams.get('X-Amz-Signature')) {
    fail('PRINT_AGENT_RELEASE_REDIRECT_INVALID', 'GitHub asset redirect is not signed')
  }
  let expiresAt = Number.NaN
  const se = parsed.searchParams.get('se')
  if (se) expiresAt = Date.parse(se)
  if (!Number.isFinite(expiresAt)) {
    const issued = parsed.searchParams.get('X-Amz-Date')
    const lifetime = Number(parsed.searchParams.get('X-Amz-Expires'))
    if (issued && Number.isFinite(lifetime) && lifetime > 0) {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(issued)
      if (match) {
        expiresAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])) + lifetime * 1000
      }
    }
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt > nowMs + 10 * 60_000) {
    fail('PRINT_AGENT_RELEASE_REDIRECT_INVALID', 'GitHub asset redirect is expired or not short-lived')
  }
  return location
}
