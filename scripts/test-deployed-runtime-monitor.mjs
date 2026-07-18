#!/usr/bin/env node

import assert from 'node:assert/strict'
import { validateMonitorSnapshot } from './monitor-deployed-runtime.mjs'

const healthy = {
  boundary: { rootRedirectsToLogin: true, tasksRejected: true },
  health: {
    status: 'ok',
    database: { status: 'reachable', migrationsCurrent: true },
    credentialStore: { status: 'reachable' },
    crm: { status: 'reachable' },
    worker: { status: 'reachable' },
    agentWorker: { status: 'reachable' },
    agentResearchWorker: { status: 'reachable' },
    toastWorker: { status: 'reachable' },
    quickBooksWorker: { status: 'reachable' },
    knowledgeWorkers: [
      { name: 'ai-radar', status: 'reachable', phase: 'idle' },
      { name: 'document-embeddings', status: 'reachable', phase: 'idle' },
    ],
    capabilities: { quickBooks: true },
  },
  persistence: { ok: true, driver: 'postgres', database: 'reachable' },
  runtime: { branch: 'main', environment: 'production' },
}

assert.deepEqual(validateMonitorSnapshot(healthy, { branch: 'main', environment: 'production' }), [])

const unhealthy = structuredClone(healthy)
unhealthy.health.quickBooksWorker.status = 'stale'
unhealthy.health.knowledgeWorkers[1].phase = 'failed'
unhealthy.boundary.tasksRejected = false
unhealthy.runtime.branch = 'dev'
assert.deepEqual(
  validateMonitorSnapshot(unhealthy, { branch: 'main', environment: 'production' }),
  [
    'unauthenticated tasks request was not rejected',
    'QuickBooks sync worker is not reachable',
    'document-embeddings worker is not healthy',
    'runtime branch is dev, expected main',
  ],
)

console.log('PASS deployed runtime monitor health, worker, persistence, and authentication boundaries')
