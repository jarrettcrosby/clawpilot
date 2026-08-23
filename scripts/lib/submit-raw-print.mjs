#!/usr/bin/env node
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  LOCAL_PRINTER_LOCK_HOLDER_READY,
  normalizedLocalPrinterEndpoint,
} from './local-print-device.mjs'

function positiveInteger(value, fallback) {
  const parsed = Number(value || fallback)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('The local printer port is invalid')
  }
  return parsed
}

async function stdinBytes(maximumBytes = 16 * 1024 * 1024) {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > maximumBytes) throw new Error('The local print payload is too large')
    chunks.push(chunk)
  }
  if (!length) throw new Error('The local print payload is empty')
  return Buffer.concat(chunks)
}

export function rawPrintFailureDisposition(input = {}) {
  const acceptedBytes = Number.isSafeInteger(Number(input?.acceptedBytes))
    ? Math.max(0, Number(input.acceptedBytes))
    : 0
  const deliveryStarted = input?.deliveryStarted === true || acceptedBytes > 0
  return {
    acceptedBytes,
    deliveryStarted,
    retryable: !deliveryStarted,
    code: deliveryStarted ? 'PRINT_OUTCOME_UNCERTAIN' : 'PRINTER_UNAVAILABLE',
  }
}

export async function submitRaw(
  payload,
  host,
  port,
  timeoutMs = 10_000,
  {
    createConnection = net.createConnection,
    claimExpiresAt = null,
    claimMonotonicDeadlineNs = null,
    now = Date.now,
    monotonicNowNs = process.hrtime.bigint,
    shouldStop = () => false,
  } = {},
) {
  const stoppedBeforeDelivery = () => {
    const error = new Error('The local print worker stopped before raw delivery began')
    error.code = 'PRINT_DELIVERY_STOPPED'
    error.acceptedBytes = 0
    error.deliveryStarted = false
    return error
  }
  const assertLeaseRemaining = (minimumMs) => {
    const hasWallDeadline = claimExpiresAt !== null
      && claimExpiresAt !== undefined
      && claimExpiresAt !== ''
    const hasMonotonicDeadline = claimMonotonicDeadlineNs !== null
      && claimMonotonicDeadlineNs !== undefined
      && claimMonotonicDeadlineNs !== ''
    if (!hasWallDeadline && !hasMonotonicDeadline) return
    let wallLeaseSafe = true
    let monotonicLeaseSafe = true
    if (hasWallDeadline) {
      const expiresAt = Date.parse(String(claimExpiresAt))
      wallLeaseSafe = Number.isFinite(expiresAt) && expiresAt - now() >= minimumMs
    }
    if (hasMonotonicDeadline) {
      let deadline
      try {
        deadline = BigInt(String(claimMonotonicDeadlineNs))
      } catch {
        monotonicLeaseSafe = false
      }
      if (deadline !== undefined) {
        monotonicLeaseSafe = deadline - monotonicNowNs()
          >= BigInt(minimumMs) * 1_000_000n
      }
    }
    if (!wallLeaseSafe || !monotonicLeaseSafe) {
      const error = new Error('The authoritative print claim expires too soon for raw delivery')
      error.code = 'PRINT_CLAIM_LEASE_TOO_SHORT'
      throw error
    }
  }
  assertLeaseRemaining(timeoutMs + 2_000)
  if (shouldStop()) throw stoppedBeforeDelivery()
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host, port })
    let acceptedBytes = 0
    let deliveryStarted = false
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) {
        error.acceptedBytes = acceptedBytes
        error.deliveryStarted = deliveryStarted
        reject(error)
      } else {
        resolvePromise({ acceptedBytes, deliveryStarted })
      }
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      if (shouldStop()) {
        finish(stoppedBeforeDelivery())
        return
      }
      try {
        assertLeaseRemaining(2_000)
      } catch (error) {
        finish(error)
        return
      }
      // Crossing this fence means socket.write was invoked. Even when its
      // callback later reports an error (or never arrives), the kernel or
      // printer may already have received bytes, so automatic retry is unsafe.
      deliveryStarted = true
      try {
        socket.write(payload, (error) => {
          if (error) return finish(error)
          acceptedBytes = payload.byteLength
          socket.end()
        })
      } catch (error) {
        finish(error)
      }
    })
    socket.once('finish', () => finish())
    socket.once('timeout', () => finish(new Error('Local printer delivery timed out')))
    socket.once('error', finish)
  })
}

async function holdEndpointLock() {
  process.stdout.write(`${LOCAL_PRINTER_LOCK_HOLDER_READY}\n`)
  process.stdin.resume()
  await new Promise((resolvePromise) => {
    let resolved = false
    const finish = () => {
      if (resolved) return
      resolved = true
      resolvePromise()
    }
    process.stdin.once('end', finish)
    process.stdin.once('close', finish)
  })
}

async function main() {
  const host = String(process.env.CLAWPILOT_PRINTER_HOST || '').trim()
  if (!host) throw new Error('The local printer endpoint is unavailable')
  const port = positiveInteger(process.env.CLAWPILOT_PRINTER_PORT, 9_100)
  const claimExpiresAt = String(
    process.env.CLAWPILOT_PRINT_CLAIM_EXPIRES_AT || '',
  ).trim() || null
  const claimMonotonicDeadlineNs = String(
    process.env.CLAWPILOT_PRINT_CLAIM_MONOTONIC_DEADLINE_NS || '',
  ).trim() || null
  normalizedLocalPrinterEndpoint(host, port)
  const payload = await stdinBytes()
  try {
    const result = await submitRaw(payload, host, port, 10_000, {
      claimExpiresAt,
      claimMonotonicDeadlineNs,
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } catch (error) {
    const disposition = rawPrintFailureDisposition(error)
    process.stdout.write(`${JSON.stringify({
      ok: false,
      acceptedBytes: disposition.acceptedBytes,
      deliveryStarted: disposition.deliveryStarted,
      code: String(error?.code || disposition.code),
    })}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const execution = process.argv.includes('--hold-endpoint-lock')
    ? holdEndpointLock()
    : main()
  execution.catch(() => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      acceptedBytes: 0,
      deliveryStarted: false,
      code: 'PRINTER_UNAVAILABLE',
    })}\n`)
    process.exitCode = 1
  })
}
