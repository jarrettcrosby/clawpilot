import {
  getRepositoryRunnerConfiguration,
  requireRepositoryRunnerConfiguration,
} from '@/lib/agents/repositoryRunnerConfig'
import {
  createGitHubInstallationToken,
  dispatchRepositoryWorkflow,
  resolveGitHubBranchSha,
} from '@/lib/githubApp'
import {
  claimRepositoryRunOutbox,
  completeRepositoryRunDispatch,
  failRepositoryRunDispatch,
} from '@/lib/persistence/repositoryRuns'

export async function processRepositoryRunOutbox(input: { maxAttempts?: number } = {}) {
  const configuration = getRepositoryRunnerConfiguration()
  if (!configuration.enabled) {
    return { enabled: false, ready: false, claimed: 0, dispatched: 0, failed: 0, dead: 0 }
  }
  requireRepositoryRunnerConfiguration()
  const item = await claimRepositoryRunOutbox({ maxAttempts: input.maxAttempts })
  if (!item) {
    return { enabled: true, ready: true, claimed: 0, dispatched: 0, failed: 0, dead: 0 }
  }

  try {
    if (
      item.repositoryFullName !== configuration.repositoryFullName
      || item.githubRepositoryId !== configuration.repositoryId
      || item.githubInstallationId !== configuration.installationId
      || item.workflowFile !== configuration.workflowFile
      || item.baseRef !== configuration.baseBranch
    ) {
      throw new Error('Repository binding does not match the server-owned runner configuration')
    }
    const credential = await createGitHubInstallationToken(configuration)
    const baseSha = await resolveGitHubBranchSha({ configuration, token: credential.token })
    await dispatchRepositoryWorkflow({
      configuration,
      token: credential.token,
      runId: item.id,
      baseSha,
      instruction: item.instruction,
    })
    await completeRepositoryRunDispatch({ item, baseSha })
    return { enabled: true, ready: true, claimed: 1, dispatched: 1, failed: 0, dead: 0 }
  } catch (error) {
    const result = await failRepositoryRunDispatch({
      item,
      error: error instanceof Error ? error.message : String(error),
      maxAttempts: input.maxAttempts,
    })
    return {
      enabled: true,
      ready: true,
      claimed: 1,
      dispatched: 0,
      failed: result === 'failed' ? 1 : 0,
      dead: result === 'dead' ? 1 : 0,
    }
  }
}
