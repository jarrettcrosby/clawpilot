#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const persistence = readFileSync('app_src/lib/persistence/careerSiteLinkedIn.ts', 'utf8')
const health = readFileSync('app_src/app/api/health/route.ts', 'utf8')

assert.match(
  persistence,
  /const WORKER_CONNECTED_SECONDS = 30/,
  'worker connectivity must have a short, explicit freshness window',
)
assert.match(
  persistence,
  /max\(created_at\)::text AS last_worker_seen_at[\s\S]*max\(created_at\) >= now\(\)[\s\S]*career_site_linkedin_worker_nonces/,
  'worker connectivity must derive from authenticated nonce observations',
)
assert.match(
  health,
  /workerConnected: databaseReadiness[.]workerConnected[\s\S]*lastWorkerSeenAt: databaseReadiness[.]lastWorkerSeenAt/,
  'health must expose safe worker freshness evidence',
)
assert.match(
  health,
  /ready: careerSiteLinkedIn[.]configured === true[\s\S]*databaseReadiness[.]schemaReady[\s\S]*databaseReadiness[.]workerConnected/,
  'LinkedIn readiness must require a recently authenticated worker',
)
assert.doesNotMatch(
  health,
  /if \(!databaseReadiness[.]workerConnected\)[\s\S]{0,300}errors[.]push/,
  'transient worker absence must not fail global health during blue-green rollout',
)

console.log('Career-site LinkedIn worker freshness health contract verified')
