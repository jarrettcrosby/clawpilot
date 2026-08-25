#!/usr/bin/env node

import {
  CommerceOrderRevisionEvidenceKeyConfigError,
  resolveCommerceOrderRevisionEvidenceKeyConfig,
} from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'

const sourcePattern = /^[a-z][a-z0-9-]{1,39}$/
const ownerDomainPattern = /^[a-z0-9.-]+$/
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
let serviceClientSources = []

function fail(message) {
  console.error(`[runtime-config] ${message}`)
  process.exit(1)
}

function validateShortLinkOrigin() {
  let origin
  try {
    const parsed = new URL(String(process.env.SHORTLINK_PUBLIC_ORIGIN || ''))
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      fail('SHORTLINK_PUBLIC_ORIGIN must be an HTTPS origin without a path, credentials, query, or fragment')
    }
    origin = parsed.origin
  } catch {
    fail('SHORTLINK_PUBLIC_ORIGIN must be a valid HTTPS origin')
  }
  return origin
}

function validateServiceClients() {
  const configured = String(process.env.SHORTLINK_SERVICE_CLIENTS_JSON || '').trim()
  if (configured) {
    let clients
    try {
      clients = JSON.parse(configured)
    } catch {
      fail('SHORTLINK_SERVICE_CLIENTS_JSON must be valid JSON')
    }
    if (!Array.isArray(clients) || clients.length === 0 || clients.length > 20) {
      fail('SHORTLINK_SERVICE_CLIENTS_JSON must contain 1-20 clients')
    }
    const sources = new Set()
    for (const client of clients) {
      const sourceApp = String(client?.sourceApp || '').trim().toLowerCase()
      const secret = String(client?.secret || '')
      const ownerDomain = String(client?.ownerDomain || '').trim().toLowerCase()
      if (!sourcePattern.test(sourceApp) || secret.length < 32 || (ownerDomain && !ownerDomainPattern.test(ownerDomain))) {
        fail('Each short-link service client needs a valid sourceApp, 32-character secret, and optional ownerDomain')
      }
      if (sources.has(sourceApp)) fail(`Short-link service source ${sourceApp} is duplicated`)
      sources.add(sourceApp)
    }
    serviceClientSources = [...sources]
    return clients.length
  }

  const secret = String(process.env.SHORTLINK_SERVICE_SECRET || '')
  const sourceApp = String(process.env.SHORTLINK_SERVICE_SOURCE || 'external-app').trim().toLowerCase()
  if (secret.length < 32 || !sourcePattern.test(sourceApp)) {
    fail('SHORTLINK_SERVICE_CLIENTS_JSON or a valid legacy short-link service client must be configured')
  }
  serviceClientSources = [sourceApp]
  return 1
}

function validateCareerSiteSubmissionsConfiguration() {
  const enabled = String(process.env.CAREER_SITE_SUBMISSIONS_ENABLED || '0').trim()
  if (enabled !== '0' && enabled !== '1') fail('CAREER_SITE_SUBMISSIONS_ENABLED must be 0 or 1')
  if (enabled === '0') return 'disabled'

  if (!serviceClientSources.includes('jarrett-career-site')) {
    fail('CAREER_SITE_SUBMISSIONS_ENABLED requires the jarrett-career-site short-link service client')
  }
  const ownerEmail = String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '').trim().toLowerCase()
  if (!ownerEmail || ownerEmail.length > 254 || !emailPattern.test(ownerEmail) || !/^[\x21-\x7e]+$/.test(ownerEmail)) {
    fail('CAREER_SITE_SUBMISSIONS_OWNER_EMAIL must be a valid email address')
  }
  const sheetId = String(process.env.CAREER_SITE_SUBMISSIONS_SHEET_ID || '').trim()
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sheetId)) {
    fail('CAREER_SITE_SUBMISSIONS_SHEET_ID must be a valid Google Sheet ID')
  }
  const sheetTab = String(process.env.CAREER_SITE_SUBMISSIONS_SHEET_TAB || 'Submissions').trim()
  if (!sheetTab || sheetTab.length > 100 || /[\u0000-\u001f\u007f]/.test(sheetTab)) {
    fail('CAREER_SITE_SUBMISSIONS_SHEET_TAB is invalid')
  }
  const sheetHeaderRow = String(process.env.CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW || '4').trim()
  if (!/^\d+$/.test(sheetHeaderRow) || Number(sheetHeaderRow) < 1 || Number(sheetHeaderRow) > 1000) {
    fail('CAREER_SITE_SUBMISSIONS_SHEET_HEADER_ROW must be an integer from 1 through 1000')
  }
  const pollMs = String(process.env.CAREER_SITE_SUBMISSIONS_POLL_MS || '10000').trim()
  if (!/^[0-9]+$/.test(pollMs) || Number(pollMs) < 5000 || Number(pollMs) > 300000) {
    fail('CAREER_SITE_SUBMISSIONS_POLL_MS must be an integer from 5000 through 300000')
  }
  return 'enabled'
}

function validateEmbeddingConfiguration() {
  const provider = String(process.env.DOCUMENT_EMBEDDINGS_PROVIDER || 'local').trim().toLowerCase()
  if (!['local', 'openai'].includes(provider)) fail('DOCUMENT_EMBEDDINGS_PROVIDER must be local or openai')
  if (provider === 'openai' && String(process.env.OPENAI_EMBEDDING_API_KEY || '').trim().length < 20) {
    fail('OPENAI_EMBEDDING_API_KEY is required when DOCUMENT_EMBEDDINGS_PROVIDER=openai')
  }
  return provider
}

function validateExactHttpsOrigin(name) {
  const configured = String(process.env[name] || '')
  try {
    const parsed = new URL(configured)
    if (parsed.protocol !== 'https:' || configured !== parsed.origin) {
      fail(`${name} must be an exact pathless HTTPS origin`)
    }
    return parsed.origin
  } catch {
    fail(`${name} must be a valid exact pathless HTTPS origin`)
  }
}

function validateSuiteCrmConfiguration() {
  const enabled = String(process.env.CRM_ENABLED || '0')
  if (enabled !== '0' && enabled !== '1') fail('CRM_ENABLED must be 0 or 1')
  if (enabled === '0') return 'disabled'

  const base = String(process.env.SUITECRM_BASE_URL || '')
  try {
    const parsed = new URL(base)
    if (
      parsed.protocol !== 'http:'
      || parsed.hostname !== 'suitecrm.railway.internal'
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      fail('SUITECRM_BASE_URL must use the private http://suitecrm.railway.internal service URL')
    }
  } catch {
    fail('SUITECRM_BASE_URL must be a valid private Railway service URL')
  }

  validateExactHttpsOrigin('SUITECRM_PUBLIC_URL')
  return 'enabled'
}

function validateRepositoryRunnerConfiguration() {
  const enabled = String(process.env.CLAWPILOT_REPOSITORY_RUNNER_ENABLED || '0')
  if (enabled !== '0' && enabled !== '1') fail('CLAWPILOT_REPOSITORY_RUNNER_ENABLED must be 0 or 1')
  if (enabled === '0') return 'disabled'

  const positiveInteger = (value) => /^[1-9][0-9]*$/.test(String(value || '').trim())
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_APP_ID)) fail('CLAWPILOT_GITHUB_APP_ID must be a positive integer')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(String(process.env.CLAWPILOT_GITHUB_APP_BOT_USER || '').trim())) {
    fail('CLAWPILOT_GITHUB_APP_BOT_USER must be the exact GitHub App bot username')
  }
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_INSTALLATION_ID)) fail('CLAWPILOT_GITHUB_INSTALLATION_ID must be a positive integer')
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_REPOSITORY_ID)) fail('CLAWPILOT_GITHUB_REPOSITORY_ID must be a positive integer')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(process.env.CLAWPILOT_GITHUB_REPOSITORY || ''))) {
    fail('CLAWPILOT_GITHUB_REPOSITORY must use owner/repository format')
  }
  const branch = String(process.env.CLAWPILOT_GITHUB_BASE_BRANCH || 'dev')
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.split('/').includes('..')) {
    fail('CLAWPILOT_GITHUB_BASE_BRANCH is invalid')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/.test(String(process.env.CLAWPILOT_GITHUB_WORKFLOW_FILE || 'clawpilot-repository-runner.yml'))) {
    fail('CLAWPILOT_GITHUB_WORKFLOW_FILE is invalid')
  }
  const privateKey = String(process.env.CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 || '')
  try {
    const decoded = Buffer.from(privateKey, 'base64').toString('utf8')
    if (!decoded.includes('BEGIN PRIVATE KEY') && !decoded.includes('BEGIN RSA PRIVATE KEY')) throw new Error('invalid')
  } catch {
    fail('CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 must contain a base64-encoded PEM private key')
  }
  if (String(process.env.CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET || '').length < 32) {
    fail('CLAWPILOT_REPOSITORY_RUNNER_REPORT_SECRET must contain at least 32 characters')
  }
  return 'enabled'
}

function validatePrintAgentReleaseConfiguration() {
  const enabled = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED || '0')
  if (enabled !== '0' && enabled !== '1') fail('CLAWPILOT_PRINT_AGENT_RELEASE_ENABLED must be 0 or 1')
  if (enabled === '0') return 'disabled'

  const positiveInteger = (value) => /^[1-9][0-9]*$/.test(String(value || '').trim())
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_APP_ID)) fail('CLAWPILOT_GITHUB_APP_ID must be a positive integer')
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_INSTALLATION_ID)) fail('CLAWPILOT_GITHUB_INSTALLATION_ID must be a positive integer')
  if (!positiveInteger(process.env.CLAWPILOT_GITHUB_REPOSITORY_ID)) fail('CLAWPILOT_GITHUB_REPOSITORY_ID must be a positive integer')
  if (String(process.env.CLAWPILOT_GITHUB_REPOSITORY || '') !== 'jarrettcrosby/clawpilot') {
    fail('CLAWPILOT_GITHUB_REPOSITORY must be jarrettcrosby/clawpilot for Print Agent releases')
  }
  const privateKey = String(process.env.CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 || '')
  try {
    const decoded = Buffer.from(privateKey, 'base64').toString('utf8')
    if (!decoded.includes('BEGIN PRIVATE KEY') && !decoded.includes('BEGIN RSA PRIVATE KEY')) throw new Error('invalid')
  } catch {
    fail('CLAWPILOT_GITHUB_APP_PRIVATE_KEY_BASE64 must contain a base64-encoded PEM private key')
  }
  const version = String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_VERSION || '').trim()
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail('CLAWPILOT_PRINT_AGENT_RELEASE_VERSION must be an exact semantic version')
  }
  if (String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_TAG || '') !== `print-gateway-v${version}`) {
    fail('CLAWPILOT_PRINT_AGENT_RELEASE_TAG must exactly match print-gateway-v<version>')
  }
  if (!/^[0-9a-f]{40}$/.test(String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_SOURCE_COMMIT || ''))) {
    fail('CLAWPILOT_PRINT_AGENT_RELEASE_SOURCE_COMMIT must be an exact lowercase 40-character commit')
  }
  if (!/^[0-9a-f]{64}$/.test(String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_INDEX_SHA256 || ''))) {
    fail('CLAWPILOT_PRINT_AGENT_RELEASE_INDEX_SHA256 must be an exact lowercase SHA-256')
  }
  if (!['0', '1'].includes(String(process.env.CLAWPILOT_PRINT_AGENT_RELEASE_PRERELEASE || ''))) {
    fail('CLAWPILOT_PRINT_AGENT_RELEASE_PRERELEASE must be explicitly set to 0 or 1')
  }
  return `enabled:${version}`
}

function validateRevisionEvidenceConfiguration() {
  try {
    const configuration = resolveCommerceOrderRevisionEvidenceKeyConfig({
      environment: process.env,
      hosted: true,
    })
    return {
      activeKeyId: configuration.activeKeyId,
      keyCount: configuration.keyIds.length,
    }
  } catch (error) {
    if (error instanceof CommerceOrderRevisionEvidenceKeyConfigError) {
      fail(error.message)
    }
    throw error
  }
}

const origin = validateShortLinkOrigin()
const clients = validateServiceClients()
const careerSiteSubmissions = validateCareerSiteSubmissionsConfiguration()
const embeddingProvider = validateEmbeddingConfiguration()
const suiteCrm = validateSuiteCrmConfiguration()
const repositoryRunner = validateRepositoryRunnerConfiguration()
const printAgentRelease = validatePrintAgentReleaseConfiguration()
const revisionEvidence = validateRevisionEvidenceConfiguration()
console.log(`[runtime-config] valid shortLinkOrigin=${origin} clients=${clients} careerSiteSubmissions=${careerSiteSubmissions} embeddingProvider=${embeddingProvider} suiteCrm=${suiteCrm} repositoryRunner=${repositoryRunner} printAgentRelease=${printAgentRelease} revisionEvidenceActiveKeyId=${revisionEvidence.activeKeyId} revisionEvidenceKeyCount=${revisionEvidence.keyCount}`)
