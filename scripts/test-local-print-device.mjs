#!/usr/bin/env node
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  opaqueLocalDeviceReference,
  assertPrivateLanPrinterAddress,
  normalizedLocalPrinterEndpoint,
  readOrCreateLocalDeviceKey,
  runWithLocalPrinterKernelLock,
} from './lib/local-print-device.mjs'

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(file)
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
  }
  throw new Error(`Timed out waiting for lock worker marker: ${file}`)
}

function workerInput(lockDirectory, marker, extraArgs = []) {
  return {
    directory: lockDirectory,
    host: '192.168.4.146',
    port: 9_100,
    timeoutMs: 3_000,
    command: process.execPath,
    args: [
      path.resolve(import.meta.dirname, 'fixtures/local-print-lock-worker.mjs'),
      '--marker',
      marker,
      ...extraArgs,
    ],
  }
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'clawpilot-local-print-device-'))
try {
  const keyPath = path.join(temporary, 'agent-one', 'device-reference.key')
  const firstKey = await readOrCreateLocalDeviceKey(keyPath)
  const secondKey = await readOrCreateLocalDeviceKey(keyPath)
  assert.equal(firstKey, secondKey)
  assert.match(firstKey, /^[a-f0-9]{64}$/)
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600)

  const reference = opaqueLocalDeviceReference({
    key: firstKey,
    host: '192.168.4.146',
    port: 9_100,
  })
  assert.match(reference, /^local-device\.v1\.[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(reference, /192\.168\.4\.146|9100/)
  assert.equal(reference, opaqueLocalDeviceReference({
    key: firstKey,
    host: '192.168.4.146',
    port: 9_100,
  }))
  assert.notEqual(reference, opaqueLocalDeviceReference({
    key: firstKey,
    host: '192.168.4.147',
    port: 9_100,
  }))
  for (const host of ['10.0.0.1', '172.16.0.1', '192.168.4.146', '169.254.2.3']) {
    assert.equal(assertPrivateLanPrinterAddress(host), host)
  }
  for (const host of [
    '8.8.8.8',
    '127.0.0.1',
    'printer.local',
    '::ffff:192.168.4.146',
    '0xc0.0xa8.0x04.0x92',
    '0300.0250.0004.0222',
  ]) assert.throws(() => normalizedLocalPrinterEndpoint(host, 9_100), /literal|private/)

  const lockDirectory = path.join(temporary, 'shared-locks')
  const firstMarker = path.join(temporary, 'first.marker')
  const secondMarker = path.join(temporary, 'second.marker')
  const first = runWithLocalPrinterKernelLock(workerInput(
    lockDirectory,
    firstMarker,
    ['--hold-ms', '350'],
  ))
  await waitForFile(firstMarker)
  const second = runWithLocalPrinterKernelLock(workerInput(
    lockDirectory,
    secondMarker,
    ['--hold-ms', '100'],
  ))
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.code, 0)
  assert.equal(secondResult.code, 0)
  const firstTiming = JSON.parse(firstResult.stdout)
  const secondTiming = JSON.parse(secondResult.stdout)
  assert.ok(
    firstTiming.endedAt <= secondTiming.startedAt
    || secondTiming.endedAt <= firstTiming.startedAt,
    'kernel endpoint lock must serialize real child processes',
  )

  const crashResult = await runWithLocalPrinterKernelLock(workerInput(
    lockDirectory,
    path.join(temporary, 'crash.marker'),
    ['--crash'],
  ))
  assert.equal(crashResult.code, 23)
  assert.equal(JSON.parse(crashResult.stdout).crashed, true)
  const recovered = await runWithLocalPrinterKernelLock(workerInput(
    lockDirectory,
    path.join(temporary, 'recovered.marker'),
    ['--hold-ms', '1'],
  ))
  assert.equal(recovered.code, 0)
  assert.equal(JSON.parse(recovered.stdout).endedAt >= 1, true)

  const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  try {
    const inheritedEnvironment = await runWithLocalPrinterKernelLock({
      ...workerInput(
        lockDirectory,
        path.join(temporary, 'electron-environment.marker'),
        ['--hold-ms', '1'],
      ),
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE }))',
      ],
    })
    assert.equal(inheritedEnvironment.code, 0)
    assert.deepEqual(JSON.parse(inheritedEnvironment.stdout), { electronRunAsNode: '1' })
  } finally {
    if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode
  }

  process.stdout.write('Local print-device privacy and serialization contracts passed\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
