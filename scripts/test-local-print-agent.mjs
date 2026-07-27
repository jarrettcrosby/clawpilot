#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port))
  })
}

function runAgent(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/run-local-print-agent.mjs', '--once'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`agent exited ${code}: ${stderr || stdout}`))
    })
  })
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'clawpilot-print-agent-'))
const ledger = path.join(temporary, 'ledger.json')
const zpl = '^XA^FO20,20^FDCLAWPILOT TEST^FS^XZ'
const claimToken = randomUUID()
const job = {
  globalId: 'gpj1234567',
  claimToken,
  claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  document: {
    globalId: 'gpf1234567',
    type: 'shipping_label',
    format: 'ZPL',
    media: 'label_4x6',
    contentSha256: createHash('sha256').update(zpl).digest('hex'),
    byteLength: Buffer.byteLength(zpl),
    storageReference: 'clawpilot-label:glb1234567',
    inlinePayload: zpl,
    encoding: 'utf8',
  },
  printer: {
    globalId: 'gpr1234567',
    code: 'ZEBRA-01',
    name: 'Zebra test printer',
  },
  attempt: 1,
}

let printed = ''
const printer = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => { printed += chunk })
})
const printerPort = await listen(printer)
const actions = []
const api = createHttpServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  actions.push({
    action: body.action,
    authorization: request.headers.authorization,
    key: request.headers['idempotency-key'],
    capabilities: body.capabilities,
  })
  response.writeHead(200, { 'content-type': 'application/json' })
  if (body.action === 'claim') {
    response.end(JSON.stringify({ ok: true, jobs: [job] }))
  } else {
    response.end(JSON.stringify({ ok: true, job: { globalId: job.globalId } }))
  }
})
const apiPort = await listen(api)

try {
  const result = await runAgent({
    CLAWPILOT_PRINT_AGENT_URL: `http://127.0.0.1:${apiPort}`,
    CLAWPILOT_PRINT_AGENT_CREDENTIAL:
      `cpprint.v1.${randomUUID()}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    CLAWPILOT_PRINTER_HOST: '127.0.0.1',
    CLAWPILOT_PRINTER_PORT: String(printerPort),
    CLAWPILOT_PRINT_AGENT_LEDGER: ledger,
  })
  assert.match(result.stdout, /"event":"job_acknowledged"/)
  assert.equal(printed, zpl)
  assert.deepEqual(actions.map((item) => item.action), ['claim', 'acknowledge'])
  assert.deepEqual(actions[0].capabilities, {
    formats: ['ZPL'],
    media: ['label_4x6'],
    documentTypes: ['shipping_label'],
  })
  assert.equal(actions[1].capabilities, undefined)
  assert.ok(actions.every((item) => item.authorization?.startsWith('Bearer cpprint.v1.')))
  assert.ok(actions.every((item) => String(item.key || '').length >= 8))
  const saved = JSON.parse(await readFile(ledger, 'utf8'))
  assert.equal(saved.claims[`${job.globalId}:${claimToken}`].state, 'acknowledged')
  process.stdout.write('Local print agent runtime contracts passed\n')
} finally {
  await Promise.all([
    new Promise((resolvePromise) => api.close(resolvePromise)),
    new Promise((resolvePromise) => printer.close(resolvePromise)),
  ])
  await rm(temporary, { recursive: true, force: true })
}
