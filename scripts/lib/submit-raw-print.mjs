#!/usr/bin/env node
import net from 'node:net'
import { pathToFileURL } from 'node:url'

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
  { createConnection = net.createConnection } = {},
) {
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

async function main() {
  const host = String(process.env.CLAWPILOT_PRINTER_HOST || '').trim()
  if (!host) throw new Error('The local printer endpoint is unavailable')
  const port = positiveInteger(process.env.CLAWPILOT_PRINTER_PORT, 9_100)
  const payload = await stdinBytes()
  try {
    const result = await submitRaw(payload, host, port)
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
  } catch (error) {
    const disposition = rawPrintFailureDisposition(error)
    process.stdout.write(`${JSON.stringify({
      ok: false,
      acceptedBytes: disposition.acceptedBytes,
      deliveryStarted: disposition.deliveryStarted,
      code: disposition.code,
    })}\n`)
    process.exitCode = 1
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      acceptedBytes: 0,
      deliveryStarted: false,
      code: 'PRINTER_UNAVAILABLE',
    })}\n`)
    process.exitCode = 1
  })
}
