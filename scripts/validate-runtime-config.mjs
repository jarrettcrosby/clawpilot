#!/usr/bin/env node

import {
  CommerceOrderRevisionEvidenceKeyConfigError,
  resolveCommerceOrderRevisionEvidenceKeyConfig,
} from '../app_src/lib/integrations/commerceOrderRevisionEvidenceKeyConfig.mjs'

const sourcePattern = /^[a-z][a-z0-9-]{1,39}$/
const ownerDomainPattern = /^[a-z0-9.-]+$/
const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const careerSiteOrganizationId = '405bb919-0364-4a88-8a62-b4c9da42cd8f'
let serviceClientSources = []
let serviceClients = []

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
      const ownerEmail = String(client?.ownerEmail || '').trim().toLowerCase()
      const organizationId = String(client?.organizationId || '').trim().toLowerCase()
      if (
        !sourcePattern.test(sourceApp)
        || secret.length < 32
        || (ownerDomain && !ownerDomainPattern.test(ownerDomain))
        || (ownerEmail && (!emailPattern.test(ownerEmail) || ownerEmail.split('@')[1] !== ownerDomain))
        || (organizationId && !uuidPattern.test(organizationId))
      ) {
        fail('Each short-link service client needs a valid sourceApp, 32-character secret, and optional matching ownerDomain/ownerEmail/organizationId')
      }
      if (sources.has(sourceApp)) fail(`Short-link service source ${sourceApp} is duplicated`)
      sources.add(sourceApp)
    }
    serviceClientSources = [...sources]
    serviceClients = clients.map((client) => ({
      sourceApp: String(client.sourceApp).trim().toLowerCase(),
      secret: String(client.secret),
      ownerDomain: String(client.ownerDomain || '').trim().toLowerCase(),
      ownerEmail: String(client.ownerEmail || '').trim().toLowerCase(),
      organizationId: String(client.organizationId || '').trim().toLowerCase(),
    }))
    return clients.length
  }

  const secret = String(process.env.SHORTLINK_SERVICE_SECRET || '')
  const sourceApp = String(process.env.SHORTLINK_SERVICE_SOURCE || 'external-app').trim().toLowerCase()
  if (secret.length < 32 || !sourcePattern.test(sourceApp)) {
    fail('SHORTLINK_SERVICE_CLIENTS_JSON or a valid legacy short-link service client must be configured')
  }
  serviceClientSources = [sourceApp]
  serviceClients = [{
    sourceApp,
    secret,
    ownerDomain: String(process.env.SHORTLINK_SERVICE_ALLOWED_OWNER_DOMAIN || '').trim().toLowerCase(),
    ownerEmail: '',
    organizationId: '',
  }]
  return 1
}

function validateCareerSiteSubmissionsConfiguration() {
  const enabled = String(process.env.CAREER_SITE_SUBMISSIONS_ENABLED || '0').trim()
  if (enabled !== '0' && enabled !== '1') fail('CAREER_SITE_SUBMISSIONS_ENABLED must be 0 or 1')
  if (enabled === '0') return 'disabled'

  if (!String(process.env.SHORTLINK_SERVICE_CLIENTS_JSON || '').trim()) {
    fail('CAREER_SITE_SUBMISSIONS_ENABLED requires an isolated SHORTLINK_SERVICE_CLIENTS_JSON entry')
  }
  const ownerEmail = String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '').trim().toLowerCase()
  if (!ownerEmail || ownerEmail.length > 254 || !emailPattern.test(ownerEmail) || !/^[\x21-\x7e]+$/.test(ownerEmail)) {
    fail('CAREER_SITE_SUBMISSIONS_OWNER_EMAIL must be a valid email address')
  }
  if (ownerEmail !== 'jarrett@suburbiasandwichco.com') {
    fail('CAREER_SITE_SUBMISSIONS_OWNER_EMAIL must be the exact Jarrett career-site owner identity')
  }
  const organizationId = String(
    process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '',
  ).trim().toLowerCase()
  if (organizationId !== careerSiteOrganizationId) {
    fail(`CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID must be ${careerSiteOrganizationId}`)
  }
  const careerClient = serviceClients.find((client) => client.sourceApp === 'jarrett-career-site')
  if (
    !serviceClientSources.includes('jarrett-career-site')
    || !careerClient
    || careerClient.ownerDomain !== 'suburbiasandwichco.com'
    || careerClient.ownerEmail !== ownerEmail
    || careerClient.organizationId !== organizationId
  ) {
    fail('CAREER_SITE_SUBMISSIONS_ENABLED requires the exact jarrett-career-site source, ownerDomain, ownerEmail, and organizationId identity')
  }
  if (serviceClients.some((client) => client !== careerClient && client.secret === careerClient.secret)) {
    fail('The jarrett-career-site short-link service secret must not be reused by another source')
  }
  if ([
    process.env.SHORTLINK_SERVICE_SECRET,
    process.env.PIPELINE_OUTBOX_WORKER_SECRET,
  ].some((secret) => secret && secret === careerClient.secret)) {
    fail('The jarrett-career-site short-link service secret must be isolated from worker and legacy credentials')
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
  const mailFrom = String(process.env.CAREER_SITE_MAIL_FROM || '').trim().toLowerCase()
  if (mailFrom !== 'info@suburbiasandwichco.com') {
    fail('CAREER_SITE_MAIL_FROM must be the verified info@suburbiasandwichco.com Gmail alias')
  }
  if (String(process.env.CAREER_SITE_MAIL_FROM_NAME || '').trim() !== 'Jarrett Crosby') {
    fail('CAREER_SITE_MAIL_FROM_NAME must be Jarrett Crosby')
  }
  const mailReplyTo = String(process.env.CAREER_SITE_MAIL_REPLY_TO || '').trim().toLowerCase()
  if (mailReplyTo !== 'jarrettcrosby@gmail.com') {
    fail('CAREER_SITE_MAIL_REPLY_TO must be JarrettCrosby@gmail.com')
  }
  const mailApprovalTo = String(process.env.CAREER_SITE_MAIL_APPROVAL_TO || '').trim().toLowerCase()
  if (mailApprovalTo !== 'jarrettcrosby@gmail.com') {
    fail('CAREER_SITE_MAIL_APPROVAL_TO must be JarrettCrosby@gmail.com')
  }
  let approvalOrigins
  try {
    approvalOrigins = JSON.parse(String(process.env.CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON || ''))
  } catch {
    fail('CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must be valid JSON')
  }
  if (!Array.isArray(approvalOrigins) || approvalOrigins.length < 1 || approvalOrigins.length > 10) {
    fail('CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must contain 1-10 exact HTTPS origins')
  }
  const normalizedApprovalOrigins = approvalOrigins.map((value) => {
    const configured = String(value || '')
    try {
      const parsed = new URL(configured)
      if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.port
        || parsed.pathname !== '/'
        || parsed.search
        || parsed.hash
        || configured !== parsed.origin
      ) throw new Error('invalid exact origin')
      return parsed.origin
    } catch {
      fail('CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON contains an invalid origin')
    }
  })
  if (
    new Set(normalizedApprovalOrigins).size !== normalizedApprovalOrigins.length
    || !normalizedApprovalOrigins.includes('https://jarrett.suburbiasandwichco.com')
  ) {
    fail('CAREER_SITE_MAIL_APPROVAL_ORIGINS_JSON must contain the exact production origin without duplicates')
  }
  return 'enabled'
}

function validateAuthMailConfiguration() {
  const connectionId = String(process.env.MATON_AUTH_GMAIL_CONNECTION_ID || '').trim()
  const sender = String(process.env.CLAWPILOT_AUTH_MAIL_FROM || '').trim().toLowerCase()
  if (Boolean(connectionId) !== Boolean(sender)) {
    fail('MATON_AUTH_GMAIL_CONNECTION_ID and CLAWPILOT_AUTH_MAIL_FROM must be configured together')
  }
  if (!connectionId) return 'platform'
  if (connectionId.length < 8 || connectionId.length > 512 || !/^[\x21-\x7e]+$/.test(connectionId)) {
    fail('MATON_AUTH_GMAIL_CONNECTION_ID must be a valid Maton connection ID')
  }
  if (connectionId === String(process.env.MATON_GMAIL_CONNECTION_ID || '').trim()) {
    fail('MATON_AUTH_GMAIL_CONNECTION_ID must differ from MATON_GMAIL_CONNECTION_ID')
  }
  if (sender.length > 254 || !emailPattern.test(sender) || !/^[\x21-\x7e]+$/.test(sender)) {
    fail('CLAWPILOT_AUTH_MAIL_FROM must be a valid email address')
  }
  return 'dedicated'
}

function validateCareerSiteAgentsConfiguration() {
  const enabled = String(process.env.CAREER_SITE_AGENTS_ENABLED || '').trim()
  if (enabled !== '1') fail('CAREER_SITE_AGENTS_ENABLED must be 1')

  if (!String(process.env.SHORTLINK_SERVICE_CLIENTS_JSON || '').trim()) {
    fail('CAREER_SITE_AGENTS_ENABLED requires an isolated SHORTLINK_SERVICE_CLIENTS_JSON entry')
  }
  const ownerEmail = String(process.env.CAREER_SITE_SUBMISSIONS_OWNER_EMAIL || '')
    .trim()
    .toLowerCase()
  if (ownerEmail !== 'jarrett@suburbiasandwichco.com') {
    fail('CAREER_SITE_AGENTS_ENABLED requires the exact Jarrett Career Desk owner identity')
  }
  const organizationId = String(
    process.env.CAREER_SITE_SUBMISSIONS_ORGANIZATION_ID || '',
  ).trim().toLowerCase()
  if (organizationId !== careerSiteOrganizationId) {
    fail(`CAREER_SITE_AGENTS_ENABLED requires organization ${careerSiteOrganizationId}`)
  }
  const agentClient = serviceClients.find(
    (client) => client.sourceApp === 'jarrett-career-agents',
  )
  if (
    !agentClient
    || agentClient.ownerDomain !== 'suburbiasandwichco.com'
    || agentClient.ownerEmail !== ownerEmail
    || agentClient.organizationId !== organizationId
  ) {
    fail('CAREER_SITE_AGENTS_ENABLED requires the exact jarrett-career-agents source, ownerDomain, ownerEmail, and organizationId identity')
  }
  if (serviceClients.some((client) => client !== agentClient && client.secret === agentClient.secret)) {
    fail('The jarrett-career-agents service secret must not be reused by another source')
  }
  if ([
    process.env.SHORTLINK_SERVICE_SECRET,
    process.env.PIPELINE_OUTBOX_WORKER_SECRET,
  ].some((secret) => secret && secret === agentClient.secret)) {
    fail('The jarrett-career-agents service secret must be isolated from worker and legacy credentials')
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
const authMail = validateAuthMailConfiguration()
const careerSiteSubmissions = validateCareerSiteSubmissionsConfiguration()
const careerSiteAgents = validateCareerSiteAgentsConfiguration()
const embeddingProvider = validateEmbeddingConfiguration()
const suiteCrm = validateSuiteCrmConfiguration()
const repositoryRunner = validateRepositoryRunnerConfiguration()
const printAgentRelease = validatePrintAgentReleaseConfiguration()
const revisionEvidence = validateRevisionEvidenceConfiguration()
console.log(`[runtime-config] valid shortLinkOrigin=${origin} clients=${clients} authMail=${authMail} careerSiteSubmissions=${careerSiteSubmissions} careerSiteAgents=${careerSiteAgents} embeddingProvider=${embeddingProvider} suiteCrm=${suiteCrm} repositoryRunner=${repositoryRunner} printAgentRelease=${printAgentRelease} revisionEvidenceActiveKeyId=${revisionEvidence.activeKeyId} revisionEvidenceKeyCount=${revisionEvidence.keyCount}`)
