#!/usr/bin/env node

const secret = String(process.env.PIPELINE_OUTBOX_WORKER_SECRET || '').trim()
if (!secret) {
  console.error('[pipeline-outbox] PIPELINE_OUTBOX_WORKER_SECRET is required')
  process.exit(1)
}

const port = String(process.env.PORT || 4002)
const baseUrl = String(process.env.PIPELINE_OUTBOX_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '')
const pipelineIntervalMs = Math.max(1000, Math.min(Number(process.env.PIPELINE_OUTBOX_POLL_MS || 10000), 300000))
const agentIntervalMs = Math.max(1000, Math.min(Number(process.env.AGENT_DISPATCH_POLL_MS || 5000), 300000))
const researchIntervalMs = Math.max(5000, Math.min(Number(process.env.AGENT_RESEARCH_POLL_MS || 10000), 300000))
const toastIntervalMs = Math.max(5000, Math.min(Number(process.env.TOAST_SYNC_POLL_MS || 15000), 300000))
const quickBooksIntervalMs = Math.max(5000, Math.min(Number(process.env.QUICKBOOKS_SYNC_POLL_MS || 30000), 300000))
const commerceCatalogIntervalMs = Math.max(5000, Math.min(Number(process.env.COMMERCE_CATALOG_SYNC_POLL_MS || 10000), 300000))
const shopifyInventoryRefreshIntervalMs = Math.max(5000, Math.min(Number(process.env.SHOPIFY_INVENTORY_REFRESH_POLL_MS || 10000), 300000))
const commerceOrderReconciliationIntervalMs = Math.max(5000, Math.min(Number(process.env.COMMERCE_ORDER_RECONCILIATION_POLL_MS || 60000), 300000))
const commerceProductImageImportIntervalMs = Math.max(5000, Math.min(Number(process.env.COMMERCE_PRODUCT_IMAGE_IMPORT_POLL_MS || 15000), 300000))
const commerceCatalogEnabled = String(process.env.CLAWPILOT_COMMERCE_INTAKE_ENABLED || '0') === '1'
const shopifyInventoryRefreshEnabled = commerceCatalogEnabled
const commerceOrderReconciliationEnabled = commerceCatalogEnabled
const commerceProductImageImportEnabled = commerceCatalogEnabled
const repositoryIntervalMs = Math.max(1000, Math.min(Number(process.env.REPOSITORY_RUNNER_POLL_MS || 5000), 300000))
const repositoryRunnerEnabled = String(process.env.CLAWPILOT_REPOSITORY_RUNNER_ENABLED || '0') === '1'
const crmIntegrationIntervalMs = Math.max(5000, Math.min(Number(process.env.CRM_INTEGRATION_POLL_MS || 30000), 300000))
const embeddingIntervalMs = Math.max(5000, Math.min(Number(process.env.DOCUMENT_EMBEDDING_POLL_MS || 15000), 300000))
const radarIntervalMs = Math.max(60000, Math.min(Number(process.env.AI_RADAR_POLL_MS || 3600000), 86400000))
let running = true

process.on('SIGINT', () => { running = false })
process.on('SIGTERM', () => { running = false })

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function poll(name, path, limit) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
    const result = text ? JSON.parse(text) : {}
    const claimed = Number(result.claimed || result.actions?.claimed || 0)
    const ingested = Number(result.ingested || result.ingestion?.messagesStored || 0)
    if (claimed > 0 || ingested > 0) {
      console.log(`[${name}] ${JSON.stringify(result)}`)
    }
    return true
  } catch (error) {
    console.warn(`[${name}] poll failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function runLoop(name, path, limit, intervalMs) {
  while (running) {
    const succeeded = await poll(name, path, limit)
    if (running) await wait(succeeded ? intervalMs : Math.min(intervalMs, 5000))
  }
}

await Promise.all([
  runLoop('pipeline-outbox', '/api/pipeline/sync/outbox/process', 10, pipelineIntervalMs),
  runLoop('crm-outbox', '/api/crm/outbox/process', 10, pipelineIntervalMs),
  runLoop('crm-integrations', '/api/crm/integrations/process', 10, crmIntegrationIntervalMs),
  runLoop('agent-dispatch', '/api/agents/dispatch/process', 1, agentIntervalMs),
  runLoop('agent-research', '/api/agents/research/process', 1, researchIntervalMs),
  runLoop('toast-sync', '/api/integrations/toast/process', 4, toastIntervalMs),
  runLoop('quickbooks-sync', '/api/integrations/quickbooks/process', 2, quickBooksIntervalMs),
  ...(commerceCatalogEnabled
    ? [runLoop('commerce-catalog', '/api/integrations/commerce/catalog/process', 2, commerceCatalogIntervalMs)]
    : []),
  ...(shopifyInventoryRefreshEnabled
    ? [runLoop('shopify-inventory-refresh', '/api/integrations/commerce/inventory/process', 2, shopifyInventoryRefreshIntervalMs)]
    : []),
  ...(commerceOrderReconciliationEnabled
    ? [runLoop('commerce-order-reconciliation', '/api/integrations/commerce/orders/process', 1, commerceOrderReconciliationIntervalMs)]
    : []),
  ...(commerceProductImageImportEnabled
    ? [runLoop('commerce-product-images', '/api/integrations/commerce/images/process', 1, commerceProductImageImportIntervalMs)]
    : []),
  ...(repositoryRunnerEnabled
    ? [runLoop('repository-runner', '/api/agents/repository-runs/process', 1, repositoryIntervalMs)]
    : []),
  runLoop('document-embeddings', '/api/docs/embeddings/process', 12, embeddingIntervalMs),
  runLoop('ai-radar', '/api/ai-radar/process', 1, radarIntervalMs),
])
