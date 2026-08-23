import {
  createGitHubContentsReadInstallationToken,
  githubContentsReadRequest,
} from '@/lib/githubApp'
import {
  requirePrintAgentReleaseConfiguration,
  PRINT_AGENT_RELEASE_REPOSITORY,
} from '@/lib/operations/printAgentReleaseConfig'
import {
  validateGitHubAssetRedirect,
  verifyPrintAgentRelease,
} from '@/lib/operations/printAgentRelease.mjs'

type ReleaseArtifact = {
  platform: 'macos' | 'windows'
  architecture: 'universal' | 'x64'
  filename: string
  byteLength: number
  sha256: string
  signed: true
  notarized: boolean
  stapled: boolean
  customerReleaseReady: true
  assetId: number
}

export type VerifiedPrintAgentRelease = {
  schemaVersion: 1
  product: 'ClawPilot Print Agent'
  version: string
  tag: string
  sourceCommit: string
  customerReleaseReady: true
  releaseIndexSha256: string
  artifacts: ReleaseArtifact[]
}

async function downloadSignedAsset(location: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(location, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('GitHub release asset request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function verifiedReleaseContext() {
  const configuration = requirePrintAgentReleaseConfiguration()
  const credential = await createGitHubContentsReadInstallationToken(configuration.repository)
  const request = (input: {
    path: string
    accept?: string
    redirect?: RequestRedirect
  }) => githubContentsReadRequest({ ...input, token: credential.token })
  const release = await verifyPrintAgentRelease({
    configuration: {
      repository: PRINT_AGENT_RELEASE_REPOSITORY,
      repositoryId: configuration.repository.repositoryId,
      version: configuration.version,
      tag: configuration.tag,
      sourceCommit: configuration.sourceCommit,
      indexFilename: configuration.indexFilename,
      indexSha256: configuration.indexSha256,
      prerelease: configuration.prerelease,
    },
    request,
    download: downloadSignedAsset,
  }) as VerifiedPrintAgentRelease
  return { release, request }
}

export async function readVerifiedPrintAgentRelease(): Promise<VerifiedPrintAgentRelease> {
  return (await verifiedReleaseContext()).release
}

export async function resolveVerifiedPrintAgentDownload(input: {
  platform: string
  architecture: string
}): Promise<string> {
  const { release, request } = await verifiedReleaseContext()
  const artifact = release.artifacts.find((candidate) => (
    candidate.platform === input.platform && candidate.architecture === input.architecture
  ))
  if (!artifact) throw new Error('PRINT_AGENT_RELEASE_ARTIFACT_NOT_FOUND')
  const response = await request({
    path: `/repos/${PRINT_AGENT_RELEASE_REPOSITORY}/releases/assets/${artifact.assetId}`,
    accept: 'application/octet-stream',
    redirect: 'manual',
  })
  if (![302, 303].includes(response.status)) {
    throw new Error('PRINT_AGENT_RELEASE_DOWNLOAD_UNAVAILABLE')
  }
  return validateGitHubAssetRedirect(response.headers.get('location') || '')
}
