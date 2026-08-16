import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const productName = 'ClawPilot Print Agent'
const configuredPayloadDirectory = String(
  process.env.CLAWPILOT_PACKAGED_PAYLOAD_DIRECTORY || '',
).trim()
const payloadDirectory = configuredPayloadDirectory
  ? path.resolve(configuredPayloadDirectory)
  : process.platform === 'darwin'
    ? path.resolve('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac')
    : path.resolve('dist', 'win-unpacked')
const executablePath = process.platform === 'darwin'
  ? path.join(payloadDirectory, `${productName}.app`, 'Contents', 'MacOS', productName)
  : path.join(payloadDirectory, `${productName}.exe`)
const resourcesPath = process.platform === 'darwin'
  ? path.join(payloadDirectory, `${productName}.app`, 'Contents', 'Resources')
  : path.join(payloadDirectory, 'resources')
const runtimePath = path.join(resourcesPath, 'runtime', 'run-local-print-agent.mjs')
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clawpilot-packaged-runtime-'))
const credential = `cpprint.v1.00000000-0000-4000-8000-000000000001.${'A'.repeat(43)}`
const zpl = '^XA^FO20,20^FDClawPilot packaged worker smoke^FS^XZ'
const actions = []
const printerBytes = []
const smokeTimeoutMs = 30_000

const printer = net.createServer((socket) => {
  socket.on('data', (chunk) => printerBytes.push(chunk))
})
printer.listen(0, '127.0.0.1')
await once(printer, 'listening')

const api = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    actions.push(body.action)
    const payload = body.action === 'claim' ? {
      ok: true,
      jobs: [{
        globalId: 'gpj-packaged-smoke',
        claimToken: '00000000-0000-4000-8000-000000000002',
        serverNow: new Date().toISOString(),
        claimExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        printer: { globalId: 'gpr-packaged-smoke' },
        document: {
          globalId: 'gpd-packaged-smoke',
          type: 'shipping_label',
          format: 'ZPL',
          encoding: 'utf8',
          media: 'label_4x6',
          inlinePayload: zpl,
          byteLength: Buffer.byteLength(zpl),
          contentSha256: createHash('sha256').update(zpl).digest('hex'),
        },
      }],
    } : { ok: true }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
})
api.listen(0, '127.0.0.1')
await once(api, 'listening')

try {
  const child = spawn(executablePath, [runtimePath, '--once'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CLAWPILOT_GATEWAY_TEST_MODE: '1',
      CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK: '1',
      CLAWPILOT_PRINT_AGENT_URL: `http://127.0.0.1:${api.address().port}`,
      CLAWPILOT_PRINT_AGENT_CREDENTIAL_FD: '3',
      CLAWPILOT_PRINTER_HOST: '127.0.0.1',
      CLAWPILOT_PRINTER_PORT: String(printer.address().port),
      CLAWPILOT_PRINT_AGENT_LEDGER: path.join(temporary, 'claim-ledger.json'),
      CLAWPILOT_PRINT_AGENT_DEVICE_KEY: path.join(temporary, 'device-reference.key'),
      CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY: path.join(temporary, 'endpoint-locks'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.stdio[3].end(`${credential}\n`)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* child already exited */ }
    }
  }, smokeTimeoutMs)
  const [code, signal] = await once(child, 'exit')
  clearTimeout(timeout)
  assert.equal(timedOut, false, 'Packaged worker exceeded its bounded smoke timeout')
  assert.equal(
    code,
    0,
    `Packaged worker failed or timed out (${signal || 'no signal'}): ${Buffer.concat(stderr).toString('utf8')}`,
  )
  assert.deepEqual(actions, ['claim', 'acknowledge'])
  assert.equal(Buffer.concat(printerBytes).toString('utf8'), zpl)
  const ledger = JSON.parse(readFileSync(path.join(temporary, 'claim-ledger.json'), 'utf8'))
  assert.equal(Object.values(ledger.deliveries)[0].state, 'acknowledged')
  assert.match(Buffer.concat(stdout).toString('utf8'), /"event":"job_acknowledged"/)
  process.stdout.write('Packaged Electron worker and nested raw-delivery helper smoke passed\n')
} finally {
  api.close()
  printer.close()
  await Promise.all([once(api, 'close'), once(printer, 'close')])
  rmSync(temporary, { recursive: true, force: true })
}
