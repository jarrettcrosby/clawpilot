import { isHostedRuntime } from '@/lib/persistence/config'

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const WORKFLOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/
const BOT_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/

export type RepositoryRunnerConfiguration = {
  enabled: boolean
  ready: boolean
  reason: string
  repositoryFullName: string
  repositoryId: string
  installationId: string
  appId: string
  appBotUser: string
  privateKey: string
  baseBranch: string
  workflowFile: string
  reportSecret: string
  callbackUrl: string
}

export type GitHubRepositoryInstallationConfiguration = {
  ready: boolean
  reason: string
  repositoryFullName: string
  repositoryId: string
  installationId: string
  appId: string
  privateKey: string
}

function positiveInteger(value: unknown): string {
  const text = String(value || '').trim()
  return /^[1-9][0-9]*$/.test(text) ? text : ''
}

function privateKeyFromEnvironment(): string {
  const encoded = String(process.env.CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 || '').trim()
  if (!encoded) return ''
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim()
    return decoded.includes('BEGIN PRIVATE KEY') || decoded.includes('BEGIN RSA PRIVATE KEY') ? decoded : ''
  } catch {
    return ''
  }
}

export function getGitHubRepositoryInstallationConfiguration(): GitHubRepositoryInstallationConfiguration {
  const repositoryFullName = String(process.env.CLAWPILOT_GITHUB_REPOSITORY || 'jarrettcrosby/clawpilot').trim()
  const repositoryId = positiveInteger(process.env.CLAWPILOT_GITHUB_REPOSITORY_ID)
  const installationId = positiveInteger(process.env.CLAWPILOT_GITHUB_INSTALLATION_ID)
  const appId = positiveInteger(process.env.CLAWPILOT_GITHUB_APP_ID)
  const privateKey = privateKeyFromEnvironment()
  const ready = REPOSITORY_PATTERN.test(repositoryFullName)
    && Boolean(repositoryId)
    && Boolean(installationId)
    && Boolean(appId)
    && Boolean(privateKey)

  return {
    ready,
    reason: ready
      ? 'GitHub repository installation is ready'
      : 'GitHub repository installation configuration is incomplete',
    repositoryFullName,
    repositoryId,
    installationId,
    appId,
    privateKey,
  }
}

function callbackUrl(): string {
  const publicUrl = String(process.env.CLAWPILOT_PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (!publicUrl) return ''
  try {
    const parsed = new URL(publicUrl)
    if (isHostedRuntime() && parsed.protocol !== 'https:') return ''
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return ''
    return `${parsed.origin}/api/agents/repository-runs/report`
  } catch {
    return ''
  }
}

export function getRepositoryRunnerConfiguration(): RepositoryRunnerConfiguration {
  const enabled = String(process.env.CLAWPILOT_REPOSITORY_RUNNER_ENABLED || '0') === '1'
  const installation = getGitHubRepositoryInstallationConfiguration()
  const { repositoryFullName, repositoryId, installationId, appId, privateKey } = installation
  const appBotUser = String(process.env.CLAWPILOT_GITHUB_APP_BOT_USER || '').trim()
  const baseBranch = String(process.env.CLAWPILOT_GITHUB_BASE_BRANCH || 'dev').trim()
  const workflowFile = String(process.env.CLAWPILOT_GITHUB_WORKFLOW_FILE || 'clawpilot-repository-runner.yml').trim()
  const reportSecret = String(process.env.CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET || '')
  const callback = callbackUrl()

  const invalid = !installation.ready
    || !BOT_USER_PATTERN.test(appBotUser)
    || !privateKey
    || !BRANCH_PATTERN.test(baseBranch)
    || baseBranch.split('/').includes('..')
    || !WORKFLOW_PATTERN.test(workflowFile)
    || reportSecret.length < 32
    || !callback

  const reason = !enabled
    ? 'Repository patch runner is disabled'
    : invalid
      ? 'Repository patch runner configuration is incomplete'
      : 'Repository patch runner is ready'

  return {
    enabled,
    ready: enabled && !invalid,
    reason,
    repositoryFullName,
    repositoryId,
    installationId,
    appId,
    appBotUser,
    privateKey,
    baseBranch,
    workflowFile,
    reportSecret,
    callbackUrl: callback,
  }
}

export function requireRepositoryRunnerConfiguration(): RepositoryRunnerConfiguration {
  const configuration = getRepositoryRunnerConfiguration()
  if (!configuration.ready) throw new Error(configuration.reason)
  return configuration
}
