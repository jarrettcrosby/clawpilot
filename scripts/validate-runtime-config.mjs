#!/usr/bin/env node

const sourcePattern = /^[a-z][a-z0-9-]{1,39}$/
const ownerDomainPattern = /^[a-z0-9.-]+$/

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
    return clients.length
  }

  const secret = String(process.env.SHORTLINK_SERVICE_SECRET || '')
  const sourceApp = String(process.env.SHORTLINK_SERVICE_SOURCE || 'external-app').trim().toLowerCase()
  if (secret.length < 32 || !sourcePattern.test(sourceApp)) {
    fail('SHORTLINK_SERVICE_CLIENTS_JSON or a valid legacy short-link service client must be configured')
  }
  return 1
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

const origin = validateShortLinkOrigin()
const clients = validateServiceClients()
const embeddingProvider = validateEmbeddingConfiguration()
const suiteCrm = validateSuiteCrmConfiguration()
console.log(`[runtime-config] valid shortLinkOrigin=${origin} clients=${clients} embeddingProvider=${embeddingProvider} suiteCrm=${suiteCrm}`)
