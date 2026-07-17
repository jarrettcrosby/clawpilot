import crypto from 'crypto'
import type { RepositoryRunnerConfiguration } from '@/lib/agents/repositoryRunnerConfig'

const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2022-11-28'

type GitHubTokenResponse = {
  token?: unknown
  expires_at?: unknown
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function appJwt(configuration: RepositoryRunnerConfiguration): string {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: configuration.appId,
  })}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), configuration.privateKey)
  return `${unsigned}.${signature.toString('base64url')}`
}

async function githubRequest(input: {
  path: string
  token: string
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
  timeoutMs?: number
}): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs || 20_000)
  try {
    return await fetch(`${GITHUB_API}${input.path}`, {
      method: input.method || 'GET',
      headers: {
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'clawpilot-repository-runner',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error('GitHub request timed out')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function publicError(response: Response, fallback: string): Promise<Error> {
  const requestId = response.headers.get('x-github-request-id')
  return new Error(`${fallback} (HTTP ${response.status}${requestId ? `, request ${requestId}` : ''})`)
}

export async function createGitHubInstallationToken(
  configuration: RepositoryRunnerConfiguration,
): Promise<{ token: string; expiresAt: string }> {
  const response = await githubRequest({
    path: `/app/installations/${configuration.installationId}/access_tokens`,
    token: appJwt(configuration),
    method: 'POST',
    body: {
      repository_ids: [Number(configuration.repositoryId)],
      permissions: { actions: 'write', contents: 'read', metadata: 'read' },
    },
  })
  if (!response.ok) throw await publicError(response, 'Unable to authorize the repository runner')
  const payload = await response.json() as GitHubTokenResponse
  const token = String(payload.token || '').trim()
  const expiresAt = String(payload.expires_at || '').trim()
  if (!token || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('GitHub returned an incomplete installation credential')
  }
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

export async function resolveGitHubBranchSha(input: {
  configuration: RepositoryRunnerConfiguration
  token: string
}): Promise<string> {
  const [owner, repository] = input.configuration.repositoryFullName.split('/')
  const ref = encodeURIComponent(`heads/${input.configuration.baseBranch}`)
  const response = await githubRequest({
    path: `/repos/${owner}/${repository}/git/ref/${ref}`,
    token: input.token,
  })
  if (!response.ok) throw await publicError(response, 'Unable to resolve the repository base branch')
  const payload = await response.json() as Record<string, unknown>
  const object = payload.object && typeof payload.object === 'object'
    ? payload.object as Record<string, unknown>
    : {}
  const sha = String(object.sha || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('GitHub returned an invalid base commit')
  return sha
}

export async function dispatchRepositoryWorkflow(input: {
  configuration: RepositoryRunnerConfiguration
  token: string
  runId: string
  baseSha: string
  instruction: string
}): Promise<void> {
  const [owner, repository] = input.configuration.repositoryFullName.split('/')
  const workflow = encodeURIComponent(input.configuration.workflowFile)
  const response = await githubRequest({
    path: `/repos/${owner}/${repository}/actions/workflows/${workflow}/dispatches`,
    token: input.token,
    method: 'POST',
    body: {
      ref: 'main',
      inputs: {
        repository_run_id: input.runId,
        dispatch_bot_user: input.configuration.appBotUser,
        callback_url: input.configuration.callbackUrl,
        base_sha: input.baseSha,
        instruction_base64: Buffer.from(input.instruction, 'utf8').toString('base64'),
      },
    },
  })
  if (!response.ok) throw await publicError(response, 'Unable to dispatch the repository workflow')
}
