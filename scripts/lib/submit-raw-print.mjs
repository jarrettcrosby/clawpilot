#!/usr/bin/env node
import net from 'node:net'

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

async function submitRaw(payload, host, port, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host, port })
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
    process.stdout.write(`${JSON.stringify({
      ok: false,
      acceptedBytes: Number(error?.acceptedBytes || 0),
      code: Number(error?.acceptedBytes || 0) > 0
        ? 'PRINT_OUTCOME_UNCERTAIN'
        : 'PRINTER_UNAVAILABLE',
    })}\n`)
    process.exitCode = 1
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    acceptedBytes: 0,
    code: 'PRINTER_UNAVAILABLE',
  })}\n`)
  process.exitCode = 1
})
