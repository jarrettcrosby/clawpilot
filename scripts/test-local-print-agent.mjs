#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

function runAgentOutcome(env) {
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
      resolvePromise({ code, stdout, stderr })
    })
  })
}

async function runAgent(env) {
  const result = await runAgentOutcome(env)
  if (result.code !== 0) {
    throw new Error(`agent exited ${result.code}: ${result.stderr || result.stdout}`)
  }
  return result
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
let loseAcknowledgementForJob = null
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
    errorMessage: body.errorMessage,
    retryable: body.retryable,
    deviceJobReference: body.deviceJobReference,
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
  if (
    body.action === 'acknowledge'
    && body.jobGlobalId === loseAcknowledgementForJob
  ) {
    loseAcknowledgementForJob = null
    response.destroy()
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
    CLAWPILOT_PRINT_AGENT_DEVICE_KEY: path.join(temporary, 'device-reference.key'),
    CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY: path.join(temporary, 'device-locks'),
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
  const acknowledgements = actions.filter((item) => item.action === 'acknowledge')
  assert.ok(acknowledgements.every((item) => (
    /^local-device\.v1\.[A-Za-z0-9_-]{43}$/.test(item.deviceJobReference)
  )))
  assert.equal(new Set(acknowledgements.map((item) => item.deviceJobReference)).size, 1)
  assert.ok(actions.every((item) => !JSON.stringify(item).includes('127.0.0.1')))
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

  const printedBeforeRecovery = printed
  const deliveredWithNewClaimToken = {
    ...jobs[0],
    claimToken: randomUUID(),
  }
  jobs.push(deliveredWithNewClaimToken)
  const deliveredActionOffset = actions.length
  const deliveredRecovery = await runAgent(environment)
  assert.match(deliveredRecovery.stdout, /"recovered":true/)
  assert.match(deliveredRecovery.stdout, /"resent":false/)
  assert.deepEqual(
    actions.slice(deliveredActionOffset).map((item) => item.action),
    ['claim', 'acknowledge'],
  )
  assert.equal(printed, printedBeforeRecovery)

  const sendingBeforeRestart = job(4, 'shipping_label', 'label_4x6')
  const ledgerBeforeRestart = JSON.parse(await readFile(ledger, 'utf8'))
  ledgerBeforeRestart.claims[
    `${sendingBeforeRestart.globalId}:${sendingBeforeRestart.claimToken}`
  ] = {
    jobGlobalId: sendingBeforeRestart.globalId,
    claimToken: sendingBeforeRestart.claimToken,
    documentGlobalId: sendingBeforeRestart.document.globalId,
    contentSha256: sendingBeforeRestart.document.contentSha256,
    state: 'sending',
    startedAt: new Date().toISOString(),
  }
  await writeFile(ledger, `${JSON.stringify(ledgerBeforeRestart, null, 2)}\n`, {
    mode: 0o600,
  })
  const uncertainWithNewClaimToken = {
    ...sendingBeforeRestart,
    claimToken: randomUUID(),
    document: {
      ...sendingBeforeRestart.document,
      // The durable sending fence must win even if a replacement claim's
      // inline representation is damaged; it may never reach the device.
      inlinePayload: '^XA^FDCORRUPT REPLACEMENT^FS^XZ',
    },
  }
  jobs.push(uncertainWithNewClaimToken)
  const uncertainActionOffset = actions.length
  const uncertainRecovery = await runAgent(environment)
  assert.match(uncertainRecovery.stdout, /"event":"job_outcome_uncertain"/)
  assert.match(uncertainRecovery.stdout, /"resent":false/)
  assert.deepEqual(
    actions.slice(uncertainActionOffset).map((item) => item.action),
    ['claim', 'fail'],
  )
  assert.equal(actions.at(-1).errorCode, 'PRINT_OUTCOME_UNCERTAIN')
  assert.equal(actions.at(-1).retryable, false)
  assert.equal(printed, printedBeforeRecovery)
  const recoveredLedger = JSON.parse(await readFile(ledger, 'utf8'))
  assert.equal(
    recoveredLedger.claims[
      `${uncertainWithNewClaimToken.globalId}:${uncertainWithNewClaimToken.claimToken}`
    ].state,
    'outcome_uncertain',
  )
  assert.ok(Object.values(recoveredLedger.deliveries).some((delivery) => (
    delivery.jobGlobalId === uncertainWithNewClaimToken.globalId
    && delivery.documentGlobalId === uncertainWithNewClaimToken.document.globalId
    && delivery.state === 'outcome_uncertain'
  )))

  const lostAcknowledgementJob = job(5, 'shipping_label', 'label_4x6')
  jobs.push(lostAcknowledgementJob)
  loseAcknowledgementForJob = lostAcknowledgementJob.globalId
  const lostAckPrintedBefore = printed
  const lostAckActionOffset = actions.length
  const lostAckResult = await runAgentOutcome(environment)
  assert.notEqual(lostAckResult.code, 0)
  assert.match(lostAckResult.stdout, /"event":"job_acknowledgement_pending"/)
  assert.deepEqual(
    actions.slice(lostAckActionOffset).map((item) => item.action),
    ['claim', 'acknowledge'],
  )
  assert.equal(
    printed,
    `${lostAckPrintedBefore}${lostAcknowledgementJob.document.inlinePayload}`,
  )
  const ledgerAfterLostAck = JSON.parse(await readFile(ledger, 'utf8'))
  assert.equal(
    ledgerAfterLostAck.claims[
      `${lostAcknowledgementJob.globalId}:${lostAcknowledgementJob.claimToken}`
    ].state,
    'delivered',
  )
  assert.ok(!actions.slice(lostAckActionOffset).some((item) => item.action === 'fail'))

  const recoveredLostAcknowledgementJob = {
    ...lostAcknowledgementJob,
    claimToken: randomUUID(),
  }
  jobs.push(recoveredLostAcknowledgementJob)
  const recoveredLostAckActionOffset = actions.length
  const recoveredLostAck = await runAgent(environment)
  assert.match(recoveredLostAck.stdout, /"recovered":true/)
  assert.match(recoveredLostAck.stdout, /"resent":false/)
  assert.deepEqual(
    actions.slice(recoveredLostAckActionOffset).map((item) => item.action),
    ['claim', 'acknowledge'],
  )
  const printedAfterLostAckRecovery = printed

  const precedenceScenarios = [
    { states: ['delivery_failed', 'sending'], expected: 'fail' },
    { states: ['sending', 'delivery_failed'], expected: 'fail' },
    { states: ['sending', 'delivered'], expected: 'acknowledge' },
    { states: ['delivered', 'sending'], expected: 'acknowledge' },
  ]
  for (const [index, scenario] of precedenceScenarios.entries()) {
    const base = job(6 + index, 'shipping_label', 'label_4x6')
    const precedenceLedger = JSON.parse(await readFile(ledger, 'utf8'))
    for (const state of scenario.states) {
      const evidenceToken = randomUUID()
      precedenceLedger.claims[`${base.globalId}:${evidenceToken}`] = {
        jobGlobalId: base.globalId,
        claimToken: evidenceToken,
        documentGlobalId: base.document.globalId,
        contentSha256: base.document.contentSha256,
        state,
        ...(state === 'sending' ? { startedAt: new Date().toISOString() } : {}),
        ...(state === 'delivery_failed'
          ? { failedAt: new Date().toISOString(), acceptedBytes: 0 }
          : {}),
        ...(state === 'delivered'
          ? {
              deliveredAt: new Date().toISOString(),
              acceptedBytes: base.document.byteLength,
            }
          : {}),
      }
    }
    await writeFile(ledger, `${JSON.stringify(precedenceLedger, null, 2)}\n`, {
      mode: 0o600,
    })
    const replacement = { ...base, claimToken: randomUUID() }
    jobs.push(replacement)
    const actionOffset = actions.length
    const recovery = await runAgent(environment)
    assert.deepEqual(
      actions.slice(actionOffset).map((item) => item.action),
      ['claim', scenario.expected],
      `Unexpected legacy-evidence precedence for ${scenario.states.join(' then ')}`,
    )
    if (scenario.expected === 'fail') {
      assert.match(recovery.stdout, /"event":"job_outcome_uncertain"/)
      assert.equal(actions.at(-1).errorCode, 'PRINT_OUTCOME_UNCERTAIN')
      assert.equal(actions.at(-1).retryable, false)
    } else {
      assert.match(recovery.stdout, /"recovered":true/)
      assert.match(recovery.stdout, /"resent":false/)
    }
  }
  assert.equal(printed, printedAfterLostAckRecovery)
  assert.ok(actions.every((item) => !JSON.stringify(item).includes('127.0.0.1')))
  process.stdout.write('Local print agent runtime contracts passed\n')
} finally {
  await Promise.all([
    new Promise((resolvePromise) => api.close(resolvePromise)),
    new Promise((resolvePromise) => printer.close(resolvePromise)),
  ])
  await rm(temporary, { recursive: true, force: true })
}
