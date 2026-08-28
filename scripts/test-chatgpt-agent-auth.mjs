#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const ts = requireFromApp('typescript')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function loadTypeScriptModule(path, globals = {}) {
  const output = ts.transpileModule(read(path), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const sandbox = {
    AbortController,
    AbortSignal,
    Buffer,
    Headers,
    Request,
    Response,
    TextDecoder,
    URL,
    clearTimeout,
    console,
    exports: module.exports,
    module,
    process,
    setTimeout,
    ...globals,
  }
  vm.runInNewContext(output, sandbox, { filename: path })
  return module.exports
}

const migration = read('db/migrations/0004_agent_chatgpt_auth.sql')
for (const fragment of [
  'CREATE TABLE IF NOT EXISTS agent_chatgpt_pending_logins',
  'CREATE TABLE IF NOT EXISTS agent_chatgpt_credentials',
  'access_token_ciphertext bytea NOT NULL',
  'refresh_token_ciphertext bytea NOT NULL',
  'plan_type text',
]) {
  assert.ok(migration.includes(fragment), `agent auth migration missing ${fragment}`)
}
assert.ok(!migration.includes('access_token text'))
assert.ok(!migration.includes('refresh_token text'))

const authSource = read('app_src/lib/agents/chatgptAuth.ts')
for (const fragment of [
  "createCipheriv('aes-256-gcm'",
  "createDecipheriv('aes-256-gcm'",
  'AGENT_CREDENTIAL_ENCRYPTION_KEY',
  'app_EMoamEEZ73f0CkXaXp7hrann',
  '/api/accounts/deviceauth/usercode',
  '/api/accounts/deviceauth/token',
  '/oauth/token',
  '/oauth/revoke',
  'FOR UPDATE',
  '@/lib/persistence/agentCredentials',
]) {
  assert.ok(authSource.includes(fragment), `agent auth adapter missing ${fragment}`)
}
assert.ok(!authSource.includes('console.'))

const providerSource = read('app_src/lib/agents/provider.ts')
assert.ok(providerSource.includes('stableAgentProfileId(input.operatorId, input.agentId)'))
assert.ok(providerSource.includes('return `clawpilot_${agentId}_${digest}`'))
assert.ok(!providerSource.includes('`${input.operatorId}\\n${input.agentId}\\n${input.taskId}`'))

const credentialStoreSource = read('app_src/lib/persistence/agentCredentials.ts')
for (const fragment of [
  'AGENT_CREDENTIAL_DATABASE_URL',
  '__clawpilotAgentCredentialPgPool',
  "await client.query('BEGIN')",
  "await client.query('COMMIT')",
  "await client.query('ROLLBACK')",
]) {
  assert.ok(credentialStoreSource.includes(fragment), `shared agent credential store missing ${fragment}`)
}

const requests = []
const responseModule = loadTypeScriptModule('app_src/lib/agents/chatgptResponses.ts', {
  async fetch(url, init) {
    requests.push({ url, init })
    return new Response([
      'data: {"type":"response.output_text.delta","delta":"Changed\\n"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"- OAuth connected"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  },
})

const result = await responseModule.runChatGPTCodexResponse({
  credential: { accessToken: 'test-access', accountId: 'account-123' },
  model: 'gpt-test',
  instructions: 'Test instructions',
  prompt: 'Test prompt',
  sessionId: 'clawpilot_test_session',
})
assert.equal(result, 'Changed\n- OAuth connected')
assert.equal(requests.length, 1)
assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses')
assert.equal(requests[0].init.headers.Authorization, 'Bearer test-access')
assert.equal(requests[0].init.headers['chatgpt-account-id'], 'account-123')
assert.equal(requests[0].init.headers['OpenAI-Beta'], 'responses=experimental')
const body = JSON.parse(requests[0].init.body)
assert.equal(body.stream, true)
assert.equal(body.store, false)
assert.equal(body.model, 'gpt-test')
assert.equal(body.input[0].content[0].text, 'Test prompt')

requests.length = 0
await responseModule.runChatGPTCodexStructuredResponse({
  credential: { accessToken: 'test-access', accountId: 'account-123' },
  model: 'gpt-test',
  instructions: 'Return JSON',
  prompt: 'Structured prompt',
  sessionId: 'clawpilot_structured_session',
  outputSchema: {
    name: 'career_test_output',
    schema: {
      type: 'object',
      properties: { result: { type: 'string' } },
      required: ['result'],
      additionalProperties: false,
    },
  },
})
const structuredBody = JSON.parse(requests[0].init.body)
assert.equal(structuredBody.text.format.type, 'json_schema')
assert.equal(structuredBody.text.format.name, 'career_test_output')
assert.equal(structuredBody.text.format.strict, true)
assert.equal(structuredBody.text.format.schema.additionalProperties, false)

const errorModule = loadTypeScriptModule('app_src/lib/agents/chatgptResponses.ts', {
  async fetch() {
    return new Response(JSON.stringify({ error: { message: 'authorization expired' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
await assert.rejects(
  errorModule.runChatGPTCodexResponse({
    credential: { accessToken: 'expired', accountId: 'account-123' },
    model: 'gpt-test',
    instructions: 'Test',
    prompt: 'Test',
    sessionId: 'clawpilot_test_session',
  }),
  (error) => error?.message === 'authorization expired' && error?.status === 401,
)

console.log('PASS test-chatgpt-agent-auth')
