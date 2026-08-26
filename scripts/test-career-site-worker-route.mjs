#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const configuration = {
  enabled: true,
  sourceApp: 'jarrett-career-site',
  ownerEmail: 'jarrett@suburbiasandwichco.com',
  organizationId: '405bb919-0364-4a88-8a62-b4c9da42cd8f',
}

function loadRoute(scenario) {
  const path = 'app_src/app/api/career-site/submissions/outbox/process/route.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const heartbeatPhases = { submission: [], mail: [] }
  let submissionPhase = 'started'
  let mailPhase = 'started'
  const success = { claimed: 0, succeeded: 0, failed: 0, dead: 0, items: [] }
  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp('node:crypto')
      if (specifier === 'next/server') {
        return {
          NextResponse: {
            json(body, init = {}) {
              return { body, status: init.status || 200 }
            },
          },
        }
      }
      if (specifier === '@/lib/careerSiteSubmissionContract') {
        return {
          CareerSiteSubmissionConfigurationError: class extends Error {},
          resolveCareerSiteSubmissionConfiguration: () => configuration,
        }
      }
      if (specifier === '@/lib/careerSiteMailContract') {
        return {
          CareerSiteMailConfigurationError: class extends Error {},
          resolveCareerSiteMailConfiguration: () => configuration,
        }
      }
      if (specifier === '@/lib/careerSiteSubmissionOutbox') {
        return {
          processCareerSiteSubmissionOutbox: async () => {
            if (scenario.submissionRejects) throw new Error('submission provider unavailable')
            return scenario.submissionResult || success
          },
        }
      }
      if (specifier === '@/lib/careerSiteMailOutbox') {
        return {
          processCareerSiteMailOutbox: async () => {
            if (scenario.mailRejects) throw new Error('mail provider unavailable')
            return scenario.mailResult || success
          },
        }
      }
      if (specifier === '@/lib/persistence/careerSiteSubmissions') {
        return {
          async recordCareerSiteSubmissionWorkerHeartbeatInPostgres(input) {
            submissionPhase = input.phase
            heartbeatPhases.submission.push(input.phase)
            return { checkedAt: new Date().toISOString() }
          },
          async readCareerSiteSubmissionOperationalHealthFromPostgres() {
            return {
              healthy: submissionPhase !== 'failed',
              status: submissionPhase === 'failed' ? 'unhealthy' : submissionPhase === 'degraded' ? 'degraded' : 'healthy',
            }
          },
        }
      }
      if (specifier === '@/lib/persistence/careerSiteMailOutbox') {
        return {
          async recordCareerSiteMailWorkerHeartbeatInPostgres(input) {
            mailPhase = input.phase
            heartbeatPhases.mail.push(input.phase)
            return { checkedAt: new Date().toISOString() }
          },
          async readCareerSiteMailOperationalHealthFromPostgres() {
            return {
              healthy: mailPhase !== 'failed',
              status: mailPhase === 'failed' ? 'unhealthy' : mailPhase === 'degraded' ? 'degraded' : 'healthy',
            }
          },
        }
      }
      throw new Error(`Unexpected worker-route test import: ${specifier}`)
    },
  }, { filename: path })
  return { route: module.exports, heartbeatPhases }
}

function request() {
  return {
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'authorization') return 'Bearer test-worker-secret'
        return null
      },
    },
    async text() { return '{}' },
  }
}

const previousSecret = process.env.PIPELINE_OUTBOX_WORKER_SECRET
process.env.PIPELINE_OUTBOX_WORKER_SECRET = 'test-worker-secret'
try {
  const bounded = loadRoute({
    mailResult: { claimed: 1, succeeded: 0, failed: 1, dead: 0, items: [] },
  })
  const boundedResponse = await bounded.route.POST(request())
  assert.equal(boundedResponse.status, 503)
  assert.equal(bounded.heartbeatPhases.mail.at(-1), 'degraded')
  assert.equal(boundedResponse.body.mailDeliveryStatus, 'degraded')

  const rejected = loadRoute({ mailRejects: true })
  const rejectedResponse = await rejected.route.POST(request())
  assert.equal(rejectedResponse.status, 503)
  assert.equal(rejected.heartbeatPhases.mail.at(-1), 'failed')
  assert.equal(rejectedResponse.body.mailDeliveryStatus, 'unhealthy')

  console.log('Career-site worker route rejection and bounded-failure health verified')
} finally {
  if (previousSecret === undefined) delete process.env.PIPELINE_OUTBOX_WORKER_SECRET
  else process.env.PIPELINE_OUTBOX_WORKER_SECRET = previousSecret
}
