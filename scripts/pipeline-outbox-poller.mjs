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
    if (Number(result.claimed || 0) > 0) {
      console.log(`[${name}] claimed=${result.claimed} succeeded=${result.succeeded} failed=${result.failed} dead=${result.dead}`)
    }
  } catch (error) {
    console.warn(`[${name}] poll failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runLoop(name, path, limit, intervalMs) {
  while (running) {
    await poll(name, path, limit)
    if (running) await wait(intervalMs)
  }
}

await Promise.all([
  runLoop('pipeline-outbox', '/api/pipeline/sync/outbox/process', 10, pipelineIntervalMs),
  runLoop('agent-dispatch', '/api/agents/dispatch/process', 1, agentIntervalMs),
])
