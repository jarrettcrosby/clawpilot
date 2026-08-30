#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')
const path = 'app_src/lib/careerSiteLinkedInWorkerAuth.ts'
const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
  fileName: path,
}).outputText
const module = { exports: {} }
class RequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}
vm.runInNewContext(output, {
  Buffer,
  Date,
  Error,
  Math,
  Number,
  String,
  console,
  exports: module.exports,
  module,
  require(specifier) {
    if (specifier === 'node:crypto') return requireFromApp('node:crypto')
    if (specifier === '@/lib/careerSiteLinkedInContract') {
      return { CareerSiteLinkedInRequestError: RequestError }
    }
    throw new Error(`Unexpected LinkedIn worker auth test import: ${specifier}`)
  },
}, { filename: path })

const fixture = {
  hmacSecret: 'hmac-fixture-secret-0123456789abcdef-EXACT',
  method: 'POST',
  pathname: '/api/internal/career-site/linkedin/worker/claim',
  timestamp: '1787980800',
  nonce: '2f4fdc89-7607-4fd0-8267-c52e89a6d1fd',
  body: '{"workerId":"worker-fixture-1","capabilities":["interactive_auth","jobs_read"]}',
  bodySha256: '5e56217bd77e52ed7cf60f275de79c1fdaad8d6b34f3d5bfad313b5becaabe78',
  expectedSignature: '7200746731d2be408f0412941a77e10dcac7b2814607c3bcf20e4779b5a77c15',
}
assert.equal(module.exports.careerSiteLinkedInWorkerSignature({
  secret: fixture.hmacSecret,
  method: fixture.method,
  pathname: fixture.pathname,
  timestamp: fixture.timestamp,
  nonce: fixture.nonce,
  body: fixture.body,
}), fixture.expectedSignature)

const headers = new Map([
  ['authorization', 'Bearer independent-worker-token-0123456789abcdef'],
  ['x-clawpilot-linkedin-worker-id', 'worker-fixture-1'],
  ['x-clawpilot-linkedin-timestamp', fixture.timestamp],
  ['x-clawpilot-linkedin-nonce', fixture.nonce],
  ['x-clawpilot-linkedin-signature', fixture.expectedSignature],
])
const req = {
  method: fixture.method,
  nextUrl: { pathname: fixture.pathname },
  headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
}
const verified = module.exports.verifyCareerSiteLinkedInWorkerSignature({
  req,
  body: fixture.body,
  bearerToken: 'independent-worker-token-0123456789abcdef',
  hmacSecret: fixture.hmacSecret,
  now: new Date(Number(fixture.timestamp) * 1000),
})
assert.equal(verified.workerId, 'worker-fixture-1')
assert.throws(() => module.exports.verifyCareerSiteLinkedInWorkerSignature({
  req,
  body: `${fixture.body} `,
  bearerToken: 'independent-worker-token-0123456789abcdef',
  hmacSecret: fixture.hmacSecret,
  now: new Date(Number(fixture.timestamp) * 1000),
}), /authorization failed/)
assert.throws(() => module.exports.verifyCareerSiteLinkedInWorkerSignature({
  req,
  body: fixture.body,
  bearerToken: 'wrong-worker-token-0123456789abcdef',
  hmacSecret: fixture.hmacSecret,
  now: new Date(Number(fixture.timestamp) * 1000),
}), /authorization failed/)

console.log('Career-site LinkedIn worker HMAC fixture and exact-body binding verified')
