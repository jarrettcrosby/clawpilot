import {
  getGitHubRepositoryInstallationConfiguration,
  type GitHubRepositoryInstallationConfiguration,
} from '@/lib/agents/repositoryRunnerConfig'

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/

export const PRINT_AGENT_RELEASE_REPOSITORY = 'jarrettcrosby/clawpilot'

export type PrintAgentReleaseConfiguration = {
  enabled: boolean
  ready: boolean
  reason: string
  repository: GitHubRepositoryInstallationConfiguration
  version: string
  tag: string
  sourceCommit: string
  indexFilename: string
  indexSha256: string
  prerelease: boolean
}

export function getPrintAgentReleaseConfiguration(): PrintAgentReleaseConfiguration {
  const enabled = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED || '0') === '1'
  const version = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_VERSION || '').trim()
  const tag = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_TAG || '').trim()
  const sourceCommitRaw = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_SOURCE_COMMIT || '').trim()
  const indexSha256Raw = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_INDEX_SHA256 || '').trim()
  const sourceCommit = sourceCommitRaw.toLowerCase()
  const indexSha256 = indexSha256Raw.toLowerCase()
  const prereleaseText = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_PRERELEASE || '').trim()
  const prerelease = prereleaseText === '1'
  const repository = getGitHubRepositoryInstallationConfiguration()
  const expectedTag = version ? `print-gateway-v${version}` : ''
  const indexFilename = version ? `ClawPilot-Print-Agent-${version}-release.json` : ''
  const valid = repository.ready
    && repository.repositoryFullName === PRINT_AGENT_RELEASE_REPOSITORY
    && VERSION.test(version)
    && tag === expectedTag
    && COMMIT.test(sourceCommit)
    && sourceCommitRaw === sourceCommit
    && SHA256.test(indexSha256)
    && indexSha256Raw === indexSha256
    && (prereleaseText === '0' || prereleaseText === '1')

  return {
    enabled,
    ready: enabled && valid,
    reason: !enabled
      ? 'Print-agent customer releases are disabled'
      : valid
        ? 'Print-agent customer release configuration is ready'
        : 'Print-agent customer release configuration is incomplete or invalid',
    repository,
    version,
    tag,
    sourceCommit,
    indexFilename,
    indexSha256,
    prerelease,
  }
}

export function requirePrintAgentReleaseConfiguration(): PrintAgentReleaseConfiguration {
  const configuration = getPrintAgentReleaseConfiguration()
  if (!configuration.ready) throw new Error(configuration.reason)
  return configuration
}
