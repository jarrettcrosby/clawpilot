#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import net from 'node:net'
import path from 'node:path'

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port))
  })
}

function configurationHtml(labelLength) {
  return `<!doctype html>
<html>
<head><title>TEST-ZEBRA - READY</title></head>
<body>
<h1>Zebra Technologies<BR>ZTC GK420d</h1>
<pre>
  +000                TEAR OFF
  TEAR OFF            PRINT MODE
  GAP/NOTCH           MEDIA TYPE
  WEB                 SENSOR TYPE
  MANUAL              SENSOR SELECT
  800                 PRINT WIDTH
  ${labelLength}                LABEL LENGTH
  39.0IN   989MM      MAXIMUM LENGTH
  +000                LABEL TOP
  +0000               LEFT POSITION
  832 8/MM FULL       RESOLUTION
  V61.17.16Z &lt;-       FIRMWARE
</pre>
</body>
</html>`
}

function runScript(args, ports) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      'scripts/calibrate-zebra-printer.mjs',
      '--host',
      '127.0.0.1',
      '--port',
      String(ports.printer),
      '--http-port',
      String(ports.http),
      '--timeout-ms',
      '1000',
      '--settle-ms',
      '10',
      ...args,
    ], {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

let configuredLength = 1396
let received = ''
let calibrationChangesLength = true
const printer = net.createServer((socket) => {
  socket.setEncoding('ascii')
  socket.on('data', (chunk) => {
    received += chunk
    if (received === '~JC\r\n' && calibrationChangesLength) configuredLength = 1218
  })
})
const http = createHttpServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(configurationHtml(configuredLength))
})
const ports = {
  printer: await listen(printer),
  http: await listen(http),
}

try {
  const inspection = await runScript(['--expected-media', 'label_4x6'], ports)
  assert.equal(inspection.code, 0)
  const inspected = JSON.parse(inspection.stdout)
  assert.equal(inspected.action, 'inspect')
  assert.equal(inspected.mutationSent, false)
  assert.equal(inspected.printer.model, 'ZTC GK420d')
  assert.equal(inspected.printer.diagnosis.configuredLabelLengthDots, 1396)
  assert.equal(inspected.printer.diagnosis.expectedLengthDots, 1219)
  assert.equal(inspected.printer.diagnosis.expectedStockMatchesCalibration, false)
  assert.equal(received, '')

  const unpaused = await runScript([
    '--expected-media',
    'label_4x6',
    '--confirm-auto-calibration',
  ], ports)
  assert.notEqual(unpaused.code, 0)
  assert.match(unpaused.stderr, /--confirm-agent-paused is required/)
  assert.equal(received, '')

  const calibrated = await runScript([
    '--expected-media',
    'label_4x6',
    '--confirm-agent-paused',
    '--confirm-auto-calibration',
  ], ports)
  assert.equal(calibrated.code, 0)
  assert.match(calibrated.stderr, /one to four labels will feed/)
  assert.equal(received, '~JC\r\n')
  const result = JSON.parse(calibrated.stdout)
  assert.equal(result.action, 'auto_media_calibration')
  assert.equal(result.command, '~JC')
  assert.equal(result.acceptedBytes, 5)
  assert.equal(result.before.diagnosis.configuredLabelLengthDots, 1396)
  assert.equal(result.after.diagnosis.configuredLabelLengthDots, 1218)
  assert.equal(result.after.diagnosis.expectedStockMatchesCalibration, true)

  configuredLength = 1396
  received = ''
  calibrationChangesLength = false
  const stillMiscalibrated = await runScript([
    '--expected-media',
    'label_4x6',
    '--confirm-agent-paused',
    '--confirm-auto-calibration',
  ], ports)
  assert.equal(stillMiscalibrated.code, 2)
  assert.match(
    stillMiscalibrated.stderr,
    /sensed media still does not match 4 x 6 stock/,
  )
  const failedResult = JSON.parse(stillMiscalibrated.stdout)
  assert.equal(failedResult.ok, false)
  assert.equal(failedResult.calibrationVerified, false)
  assert.equal(
    failedResult.after.diagnosis.expectedStockMatchesCalibration,
    false,
  )
  assert.match(failedResult.requiredAction, /reload actual 4 x 6 gap stock/)

  process.stdout.write('Zebra printer calibration contracts passed\n')
} finally {
  await Promise.all([
    new Promise((resolvePromise) => printer.close(resolvePromise)),
    new Promise((resolvePromise) => http.close(resolvePromise)),
  ])
}
