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
function job(index, type, media) {
  const suffix = String(1_234_567 + index)
  const zpl = `^XA^FO20,20^FDCLAWPILOT ${type} ${media}^FS^XZ`
  return {
    globalId: `gpj${suffix}`,
    claimToken: randomUUID(),
    claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    document: {
      globalId: `gpf${suffix}`,
      type,
      format: 'ZPL',
      media,
      contentSha256: createHash('sha256').update(zpl).digest('hex'),
      byteLength: Buffer.byteLength(zpl),
      storageReference: `clawpilot-label:glb${suffix}`,
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
}
const jobs = [
  job(0, 'shipping_label', 'label_4x6'),
  job(1, 'product_label', 'label_2x1'),
  job(2, 'location_label', 'label_4x8'),
  job(3, 'shipping_label', 'label_2x1'),
]

let printed = ''
const printer = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => { printed += chunk })
})
const printerPort = await listen(printer)
const actions = []
let nextJob = 0
let legacyMismatchPending = true
const api = createHttpServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  actions.push({
    action: body.action,
    authorization: request.headers.authorization,
    key: request.headers['idempotency-key'],
    capabilities: body.capabilities,
    jobGlobalId: body.jobGlobalId,
    errorCode: body.errorCode,
  })
  if (
    body.action === 'claim'
    && legacyMismatchPending
    && body.capabilities?.media?.includes('label_2x1')
  ) {
    legacyMismatchPending = false
    response.writeHead(409, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      ok: false,
      code: 'OPERATIONS_PRINT_AGENT_CAPABILITIES_MISMATCH',
    }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  if (body.action === 'claim') {
    response.end(JSON.stringify({ ok: true, jobs: [jobs[nextJob++]] }))
  } else {
    response.end(JSON.stringify({ ok: true, job: { globalId: body.jobGlobalId } }))
  }
})
const apiPort = await listen(api)

try {
  const environment = {
    CLAWPILOT_PRINT_AGENT_URL: `http://127.0.0.1:${apiPort}`,
    CLAWPILOT_PRINT_AGENT_CREDENTIAL:
      `cpprint.v1.${randomUUID()}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    CLAWPILOT_PRINTER_HOST: '127.0.0.1',
    CLAWPILOT_PRINTER_PORT: String(printerPort),
    CLAWPILOT_PRINT_AGENT_LEDGER: ledger,
  }
  const results = []
  for (const _job of jobs) results.push(await runAgent(environment))
  for (const result of results.slice(0, 3)) {
    assert.match(result.stdout, /"event":"job_acknowledged"/)
  }
  assert.match(results[0].stdout, /"event":"legacy_enrollment_capability_fallback"/)
  assert.match(results[3].stdout, /"event":"job_rejected"/)
  assert.equal(
    printed,
    jobs.slice(0, 3).map((item) => item.document.inlinePayload).join(''),
  )
  assert.deepEqual(actions.map((item) => item.action), [
    'claim',
    'claim', 'acknowledge',
    'claim', 'acknowledge',
    'claim', 'acknowledge',
    'claim', 'fail',
  ])
  const expectedCapabilities = {
    formats: ['ZPL'],
    media: ['label_2x1', 'label_3x1', 'label_4x2', 'label_4x6', 'label_4x8'],
    documentTypes: ['shipping_label', 'product_label', 'location_label'],
  }
  const claimActions = actions.filter((item) => item.action === 'claim')
  assert.deepEqual(claimActions[0].capabilities, expectedCapabilities)
  assert.deepEqual(claimActions[1].capabilities, {
    formats: ['ZPL'],
    media: ['label_4x6'],
    documentTypes: ['shipping_label'],
  })
  for (const action of claimActions.slice(2)) {
    assert.deepEqual(action.capabilities, expectedCapabilities)
  }
  assert.ok(actions.filter((item) => item.action !== 'claim').every((item) => (
    item.capabilities === undefined
  )))
  assert.equal(actions.at(-1).jobGlobalId, jobs[3].globalId)
  assert.equal(actions.at(-1).errorCode, 'PRINT_ARTIFACT_INVALID')
  assert.ok(actions.every((item) => item.authorization?.startsWith('Bearer cpprint.v1.')))
  assert.ok(actions.every((item) => String(item.key || '').length >= 8))
  const saved = JSON.parse(await readFile(ledger, 'utf8'))
  for (const validJob of jobs.slice(0, 3)) {
    assert.equal(
      saved.claims[`${validJob.globalId}:${validJob.claimToken}`].state,
      'acknowledged',
    )
  }
  assert.equal(saved.claims[`${jobs[3].globalId}:${jobs[3].claimToken}`], undefined)
  process.stdout.write('Local print agent runtime contracts passed\n')
} finally {
  await Promise.all([
    new Promise((resolvePromise) => api.close(resolvePromise)),
    new Promise((resolvePromise) => printer.close(resolvePromise)),
  ])
  await rm(temporary, { recursive: true, force: true })
}
