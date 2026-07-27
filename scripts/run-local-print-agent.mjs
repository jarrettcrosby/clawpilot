#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const once = args.has('--once')
const probeOnly = args.has('--probe')
const help = args.has('--help') || args.has('-h')
const pollIntervalMs = positiveInteger(process.env.CLAWPILOT_PRINT_AGENT_POLL_MS, 2_000)
const printerPort = positiveInteger(process.env.CLAWPILOT_PRINTER_PORT, 9_100)
const printerHost = String(process.env.CLAWPILOT_PRINTER_HOST || '').trim()
const workerCapabilities = Object.freeze({
  formats: ['ZPL'],
  media: ['label_4x6'],
  documentTypes: ['shipping_label'],
})
const ledgerPath = expandHome(
  process.env.CLAWPILOT_PRINT_AGENT_LEDGER
    || '~/.clawpilot/print-agent-ledger.json',
)

if (help) {
  process.stdout.write(`ClawPilot local print agent

Required environment:
  CLAWPILOT_PRINT_AGENT_URL          ClawPilot deployment base URL
  CLAWPILOT_PRINT_AGENT_CREDENTIAL   One-time enrolled cpprint credential
  CLAWPILOT_PRINTER_HOST             Printer hostname or IP address

Optional environment:
  CLAWPILOT_PRINTER_PORT             Raw printer port (default 9100)
  CLAWPILOT_PRINT_AGENT_LEDGER       Local duplicate fence ledger
  CLAWPILOT_PRINT_AGENT_POLL_MS      Poll interval (default 2000)
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE
  CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT

Options:
  --once    Claim at most one job and exit
  --probe   Test the raw printer connection without claiming work

Runtime capability:
  Raw UTF-8 ZPL shipping labels on 4 x 6 label media only
`)
  process.exit(0)
}

function positiveInteger(value, fallback) {
  const number = Number(value || fallback)
  if (!Number.isSafeInteger(number) || number < 1 || number > 65_535) {
    throw new Error('A positive integer configuration value is invalid')
  }
  return number
}

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function endpointUrl() {
  const configured = String(process.env.CLAWPILOT_PRINT_AGENT_URL || '').trim()
  if (!configured) throw new Error('CLAWPILOT_PRINT_AGENT_URL is required')
  const base = new URL(configured)
  if (!['http:', 'https:'].includes(base.protocol)) {
    throw new Error('CLAWPILOT_PRINT_AGENT_URL must use HTTP or HTTPS')
  }
  return new URL('/api/operations/print-agent/jobs', base).toString()
}

function credential() {
  const direct = String(process.env.CLAWPILOT_PRINT_AGENT_CREDENTIAL || '').trim()
  if (direct) return direct
  const service = String(
    process.env.CLAWPILOT_PRINT_AGENT_KEYCHAIN_SERVICE || '',
  ).trim()
  const account = String(
    process.env.CLAWPILOT_PRINT_AGENT_KEYCHAIN_ACCOUNT || '',
  ).trim()
  if (!service || !account) {
    throw new Error('CLAWPILOT_PRINT_AGENT_CREDENTIAL is required')
  }
  return execFileSync(
    '/usr/bin/security',
    ['find-generic-password', '-s', service, '-a', account, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

function assertConfiguration() {
  if (!printerHost) throw new Error('CLAWPILOT_PRINTER_HOST is required')
  const token = credential()
  if (!/^cpprint\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/i.test(token)) {
    throw new Error('The local print-agent credential has an invalid shape')
  }
  return { endpoint: endpointUrl(), token }
}

function log(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...detail,
  })}\n`)
}

async function readLedger() {
  try {
    const parsed = JSON.parse(await fs.readFile(ledgerPath, 'utf8'))
    if (parsed?.version !== 1 || !parsed.claims || typeof parsed.claims !== 'object') {
      throw new Error('Local print ledger has an unsupported shape')
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, claims: {} }
    throw error
  }
}

async function writeLedger(ledger) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 })
  const temporary = `${ledgerPath}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: 0o600,
  })
  await fs.rename(temporary, ledgerPath)
}

async function agentRequest(config, action, payload, key) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(20_000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.ok !== true) {
    const code = String(result.code || `HTTP_${response.status}`)
    throw new Error(`Print-agent ${action} failed (${code})`)
  }
  return result
}

function decodeAndVerify(job) {
  const document = job?.document
  if (
    !job?.globalId
    || !job?.claimToken
    || document?.format !== 'ZPL'
    || document?.encoding !== 'utf8'
    || typeof document?.inlinePayload !== 'string'
  ) {
    throw new Error('This Zebra worker only accepts inline UTF-8 ZPL artifacts')
  }
  const payload = Buffer.from(document.inlinePayload, 'utf8')
  const digest = createHash('sha256').update(payload).digest('hex')
  if (payload.byteLength !== Number(document.byteLength)) {
    throw new Error('Print artifact byte length does not match its immutable metadata')
  }
  if (digest !== String(document.contentSha256 || '').toLowerCase()) {
    throw new Error('Print artifact digest does not match its immutable metadata')
  }
  return payload
}

async function probePrinter(timeoutMs = 3_000) {
  await new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: printerHost, port: printerPort })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise()
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Printer connection timed out'))
    })
    socket.once('error', reject)
  })
}

async function submitRaw(payload, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: printerHost, port: printerPort })
    let acceptedBytes = 0
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) {
        error.acceptedBytes = acceptedBytes
        reject(error)
      } else {
        resolvePromise({ acceptedBytes })
      }
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(payload, (error) => {
        if (error) return finish(error)
        acceptedBytes = payload.byteLength
        socket.end()
      })
    })
    socket.once('finish', () => finish())
    socket.once('timeout', () => finish(new Error('Printer delivery timed out')))
    socket.once('error', finish)
  })
}

function claimKey(job) {
  return `${job.globalId}:${job.claimToken}`
}

async function failClaim(config, job, input) {
  return agentRequest(config, 'fail', {
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage.slice(0, 1_000),
    retryable: input.retryable,
    printerUnavailable: input.printerUnavailable,
    retryAfterSeconds: input.retryAfterSeconds || 0,
  }, `fail:${job.globalId}:${job.claimToken}`)
}

async function acknowledgeClaim(config, job) {
  return agentRequest(config, 'acknowledge', {
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    deviceJobReference: `${printerHost}:${printerPort}`,
  }, `ack:${job.globalId}:${job.claimToken}`)
}

async function handleJob(config, ledger, job) {
  const key = claimKey(job)
  const previous = ledger.claims[key]
  if (previous?.state === 'acknowledged') {
    log('claim_already_acknowledged', { jobGlobalId: job.globalId })
    return
  }
  if (previous?.state === 'delivered') {
    await acknowledgeClaim(config, job)
    previous.state = 'acknowledged'
    previous.acknowledgedAt = new Date().toISOString()
    await writeLedger(ledger)
    log('job_acknowledged', { jobGlobalId: job.globalId, recovered: true })
    return
  }
  if (previous?.state === 'sending') {
    await failClaim(config, job, {
      errorCode: 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: 'The local agent restarted after delivery began; automatic resend was fenced',
      retryable: false,
      printerUnavailable: false,
    })
    previous.state = 'outcome_uncertain'
    previous.failedAt = new Date().toISOString()
    await writeLedger(ledger)
    log('job_outcome_uncertain', { jobGlobalId: job.globalId })
    return
  }

  let payload
  try {
    payload = decodeAndVerify(job)
  } catch (error) {
    await failClaim(config, job, {
      errorCode: 'PRINT_ARTIFACT_INVALID',
      errorMessage: error.message,
      retryable: false,
      printerUnavailable: false,
    })
    log('job_rejected', { jobGlobalId: job.globalId, reason: error.message })
    return
  }

  ledger.claims[key] = {
    jobGlobalId: job.globalId,
    claimToken: job.claimToken,
    documentGlobalId: job.document.globalId,
    state: 'sending',
    startedAt: new Date().toISOString(),
  }
  await writeLedger(ledger)

  try {
    const result = await submitRaw(payload)
    ledger.claims[key].state = 'delivered'
    ledger.claims[key].deliveredAt = new Date().toISOString()
    ledger.claims[key].acceptedBytes = result.acceptedBytes
    await writeLedger(ledger)
    await acknowledgeClaim(config, job)
    ledger.claims[key].state = 'acknowledged'
    ledger.claims[key].acknowledgedAt = new Date().toISOString()
    await writeLedger(ledger)
    log('job_acknowledged', {
      jobGlobalId: job.globalId,
      printerGlobalId: job.printer?.globalId,
      bytes: result.acceptedBytes,
    })
  } catch (error) {
    const acceptedBytes = Number(error?.acceptedBytes || 0)
    const retryable = acceptedBytes === 0
    ledger.claims[key].state = retryable ? 'delivery_failed' : 'outcome_uncertain'
    ledger.claims[key].failedAt = new Date().toISOString()
    ledger.claims[key].acceptedBytes = acceptedBytes
    await writeLedger(ledger)
    await failClaim(config, job, {
      errorCode: retryable ? 'PRINTER_UNAVAILABLE' : 'PRINT_OUTCOME_UNCERTAIN',
      errorMessage: retryable
        ? `Printer ${printerHost}:${printerPort} did not accept the artifact`
        : 'Printer delivery began but completion could not be proven; automatic resend was fenced',
      retryable,
      printerUnavailable: retryable,
      retryAfterSeconds: retryable ? 10 : 0,
    })
    log('job_failed', {
      jobGlobalId: job.globalId,
      retryable,
      acceptedBytes,
    })
  }
}

async function cycle(config, ledger) {
  const response = await agentRequest(config, 'claim', {
    limit: 1,
    leaseSeconds: 120,
    capabilities: workerCapabilities,
  }, `claim:${os.hostname()}:${randomUUID()}`)
  const jobs = Array.isArray(response.jobs) ? response.jobs : []
  if (jobs[0]) await handleJob(config, ledger, jobs[0])
  return jobs.length
}

async function main() {
  if (probeOnly) {
    if (!printerHost) throw new Error('CLAWPILOT_PRINTER_HOST is required')
    await probePrinter()
    log('printer_reachable', { printerHost, printerPort })
    return
  }
  const config = assertConfiguration()
  const ledger = await readLedger()
  let stopping = false
  process.once('SIGINT', () => { stopping = true })
  process.once('SIGTERM', () => { stopping = true })
  do {
    try {
      const count = await cycle(config, ledger)
      if (once) return
      await new Promise((resolvePromise) => setTimeout(
        resolvePromise,
        count ? 50 : pollIntervalMs,
      ))
    } catch (error) {
      log('poll_failed', { message: error.message })
      if (once) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    }
  } while (!stopping)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
