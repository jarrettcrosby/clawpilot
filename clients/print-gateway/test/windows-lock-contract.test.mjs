import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { localPrinterLockInvocation } from '../../../scripts/lib/local-print-device.mjs'
import { workerLifetimeLockInvocation } from '../src/lib/worker-manager.mjs'

const helperPath = 'C:\\Program Files\\ClawPilot\\resources\\runtime\\lib\\clawpilot-print-lock.exe'
const macHelperPath = '/Applications/ClawPilot Print Agent.app/Contents/Resources/runtime/lib/clawpilot-print-lock'

test('macOS endpoint and worker lifetime locks use the bundled native helper', () => {
  const endpoint = localPrinterLockInvocation({
    platform: 'darwin',
    lockPath: '/Library/Application Support/ClawPilot/endpoint.lock',
    timeoutSeconds: 15,
    command: '/Applications/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
    args: ['/Applications/ClawPilot Print Agent.app/Contents/Resources/runtime/lib/submit-raw-print.mjs'],
    macHelperPath,
    fileExists: (value) => value === macHelperPath,
  })
  assert.equal(endpoint.command, macHelperPath)
  assert.deepEqual(endpoint.args.slice(0, 6), [
    '--lock-path',
    '/Library/Application Support/ClawPilot/endpoint.lock',
    '--timeout-ms',
    '15000',
    '--command',
    '/Applications/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
  ])

  const lifetime = workerLifetimeLockInvocation({
    platform: 'darwin',
    lockPath: '/Library/Application Support/ClawPilot/worker.lock',
    command: '/Applications/ClawPilot Print Agent.app/Contents/MacOS/ClawPilot Print Agent',
    args: ['/Applications/ClawPilot Print Agent.app/Contents/Resources/runtime/run-local-print-agent.mjs'],
    macHelperPath,
    fileExists: (value) => value === macHelperPath,
  })
  assert.equal(lifetime.command, macHelperPath)
  assert.equal(lifetime.args[3], '1')

  const helperSource = readFileSync(path.resolve(
    import.meta.dirname,
    '../native/macos/clawpilot-print-lock.c',
  ), 'utf8')
  assert.match(helperSource, /flock\(descriptor, LOCK_EX \| LOCK_NB\)/)
  assert.match(helperSource, /execv\(command, &argv\[command_index\]\)/)
})

test('Windows endpoint delivery uses bundled native named-mutex helper without PowerShell', () => {
  const digest = 'a'.repeat(64)
  const invocation = localPrinterLockInvocation({
    platform: 'win32',
    lockPath: path.win32.join('C:\\Gateway', `${digest}.lock`),
    timeoutSeconds: 15,
    command: 'C:\\Program Files\\ClawPilot\\gateway.exe',
    args: ['C:\\Program Files\\ClawPilot\\runtime\\submit-raw-print.mjs'],
    windowsHelperPath: helperPath,
    fileExists: () => true,
  })
  assert.equal(invocation.command, helperPath)
  assert.deepEqual(invocation.args, [
    '--mutex-name',
    `ClawPilotPrintEndpoint_${digest}`,
    '--timeout-ms',
    '15000',
    '--command',
    'C:\\Program Files\\ClawPilot\\gateway.exe',
    '--',
    'C:\\Program Files\\ClawPilot\\runtime\\submit-raw-print.mjs',
  ])
  assert.doesNotMatch(JSON.stringify(invocation), /powershell|ExecutionPolicy/i)
})

test('Windows worker lifetime uses the native supervisor and kill-on-close job', () => {
  const invocation = workerLifetimeLockInvocation({
    platform: 'win32',
    lockPath: 'C:\\Gateway\\worker-instance.lock',
    command: 'C:\\Program Files\\ClawPilot\\ClawPilot Print Agent.exe',
    args: ['C:\\Program Files\\ClawPilot\\resources\\runtime\\run-local-print-agent.mjs'],
    windowsHelperPath: helperPath,
    fileExists: () => true,
  })
  assert.equal(invocation.command, helperPath)
  assert.match(invocation.args[1], /^ClawPilotPrintEndpoint_[a-f0-9]{64}$/)
  const helperSource = readFileSync(path.resolve(
    import.meta.dirname,
    '../native/windows/clawpilot-print-lock.cpp',
  ), 'utf8')
  assert.match(helperSource, /CreateMutexW/)
  assert.match(helperSource, /WAIT_ABANDONED/)
  assert.match(helperSource, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
  assert.match(helperSource, /CREATE_SUSPENDED/)
  assert.match(helperSource, /AssignProcessToJobObject/)
  assert.doesNotMatch(helperSource, /PowerShell|ExecutionPolicy/i)

  const buildSource = readFileSync(path.resolve(
    import.meta.dirname,
    '../scripts/build-windows-lock-helper.mjs',
  ), 'utf8')
  assert.match(buildSource, /'\/MT'/)
  assert.match(buildSource, /windowsVerbatimArguments:\s*true/)
})
