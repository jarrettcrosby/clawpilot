#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  assertMacPrintRuntimeCredential,
  macPrintPairingIdempotencyKey,
  macPrintPairingSecretKind,
  redeemMacPrintPairingGrant,
} from './lib/macos-print-agent-credential.mjs'

const pairingCode = `cppair.v1.00000000-0000-4000-8000-000000000001.${'a'.repeat(43)}`
const runtimeCredential = `cpprint.v1.00000000-0000-4000-8000-000000000002.${'b'.repeat(43)}`

assert.equal(macPrintPairingSecretKind(pairingCode), 'pairing_grant')
assert.equal(macPrintPairingSecretKind(runtimeCredential), 'legacy_runtime_credential')
assert.equal(macPrintPairingSecretKind('not-a-secret'), null)
assert.equal(assertMacPrintRuntimeCredential(runtimeCredential), runtimeCredential)
assert.equal(
  macPrintPairingIdempotencyKey(pairingCode),
  'print-agent-pair:51ef1c3b331afee6139ffa7675a17d7795aeb670612d497c4380030f308080b0',
)

let request
const redeemed = await redeemMacPrintPairingGrant({
  baseUrl: 'https://dev.aiapp.eigenracing.com/untrusted/path',
  pairingCode,
  idempotencyKey: 'print-agent-pair:00000000-0000-4000-8000-000000000003',
  fetchImplementation: async (url, options) => {
    request = { url: url.toString(), options }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        agent: { globalId: 'gpt0123456' },
        credential: runtimeCredential,
        replayed: false,
      }),
    }
  },
})
assert.equal(redeemed, runtimeCredential)
assert.equal(
  request.url,
  'https://dev.aiapp.eigenracing.com/api/operations/print-agent/pair',
)
assert.equal(request.options.method, 'POST')
assert.equal(request.options.headers['content-type'], 'application/json')
assert.equal(
  request.options.headers['idempotency-key'],
  'print-agent-pair:00000000-0000-4000-8000-000000000003',
)
assert.deepEqual(JSON.parse(request.options.body), { pairingCode })
assert.ok(request.options.signal instanceof AbortSignal)

await assert.rejects(
  redeemMacPrintPairingGrant({
    baseUrl: 'http://dev.aiapp.eigenracing.com',
    pairingCode,
    idempotencyKey: 'print-agent-pair:test',
    fetchImplementation: async () => assert.fail('insecure redemption must not dispatch'),
  }),
  /requires HTTPS/,
)

await assert.rejects(
  redeemMacPrintPairingGrant({
    baseUrl: 'https://dev.aiapp.eigenracing.com',
    pairingCode,
    idempotencyKey: 'print-agent-pair:test',
    fetchImplementation: async () => ({
      ok: false,
      status: 410,
      json: async () => ({ code: 'OPERATIONS_PRINT_AGENT_PAIRING_CODE_CONSUMED' }),
    }),
  }),
  /PAIRING_CODE_CONSUMED/,
)

await assert.rejects(
  redeemMacPrintPairingGrant({
    baseUrl: 'https://dev.aiapp.eigenracing.com',
    pairingCode,
    idempotencyKey: 'print-agent-pair:test',
    fetchImplementation: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ credential: pairingCode, replayed: false }),
    }),
  }),
  /valid print-agent runtime credential/,
)

const pairingSource = await import('node:fs').then(({ readFileSync }) => (
  readFileSync('scripts/pair-macos-print-agent.mjs', 'utf8')
))
assert.match(pairingSource, /replaceKeychainValueFromStdin/)
assert.match(
  pairingSource,
  /\['add-generic-password', '-U', '-s', service, '-a', account, '-w'\]/,
)
assert.match(pairingSource, /input: `\$\{value\}\\n`/)
assert.match(pairingSource, /macPrintPairingIdempotencyKey\(suppliedSecret\)/)
assert.match(pairingSource, /Legacy\/manual cpprint credential accepted/)

process.stdout.write('macOS print-agent short-lived pairing-grant contracts passed\n')
