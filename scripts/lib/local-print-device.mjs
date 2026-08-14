import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEVICE_KEY_PATTERN = /^[a-f0-9]{64}$/
const DEFAULT_LOCK_TIMEOUT_MS = 15_000

function expandHome(value) {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

export function normalizedLocalPrinterEndpoint(host, port) {
  const normalizedHost = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  const normalizedPort = Number(port)
  if (
    !normalizedHost
    || normalizedHost.length > 253
    || /[\u0000-\u0020\u007f/\\]/.test(normalizedHost)
  ) {
    throw new Error('The local printer hostname or IP address is invalid')
  }
  if (!Number.isSafeInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error('The local printer port is invalid')
  }
  return `${normalizedHost}:${normalizedPort}`
}

export async function readOrCreateLocalDeviceKey(keyPath) {
  const resolved = expandHome(String(keyPath || '').trim())
  if (!resolved) throw new Error('The local device-key path is required')
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 })
  try {
    const handle = await fs.open(resolved, 'wx', 0o600)
    try {
      await handle.writeFile(`${randomBytes(32).toString('hex')}\n`, { encoding: 'utf8' })
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  await fs.chmod(resolved, 0o600)
  const key = (await fs.readFile(resolved, 'utf8')).trim().toLowerCase()
  if (!DEVICE_KEY_PATTERN.test(key)) {
    throw new Error('The local device-reference key is invalid')
  }
  return key
}

export function opaqueLocalDeviceReference({ key, host, port }) {
  const normalizedKey = String(key || '').trim().toLowerCase()
  if (!DEVICE_KEY_PATTERN.test(normalizedKey)) {
    throw new Error('The local device-reference key is invalid')
  }
  const digest = createHmac('sha256', Buffer.from(normalizedKey, 'hex'))
    .update(`clawpilot:local-print-device:v1\n${normalizedLocalPrinterEndpoint(host, port)}`)
    .digest('base64url')
  return `local-device.v1.${digest}`
}

function endpointLockName(host, port) {
  return createHash('sha256')
    .update(`clawpilot:local-print-endpoint-lock:v1\n${normalizedLocalPrinterEndpoint(host, port)}`)
    .digest('hex')
}

function kernelLockInvocation(lockPath, timeoutSeconds, command, args) {
  if (process.platform === 'darwin' && existsSync('/usr/bin/lockf')) {
    return {
      command: '/usr/bin/lockf',
      args: ['-t', String(timeoutSeconds), lockPath, command, ...args],
    }
  }
  if (process.platform === 'linux' && existsSync('/usr/bin/flock')) {
    return {
      command: '/usr/bin/flock',
      args: ['-E', '75', '-w', String(timeoutSeconds), lockPath, command, ...args],
    }
  }
  throw new Error('A supported kernel file-lock utility is required for local printing')
}

export async function runWithLocalPrinterKernelLock(input) {
  const directory = expandHome(String(input.directory || '').trim())
  if (!directory) throw new Error('The local printer lock directory is required')
  const timeoutMs = Number(input.timeoutMs || DEFAULT_LOCK_TIMEOUT_MS)
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 250
    || timeoutMs > 60_000
  ) {
    throw new Error('The local printer lock timing is invalid')
  }
  const command = String(input.command || '').trim()
  if (!command || !Array.isArray(input.args)) {
    throw new Error('A local printer delivery command is required')
  }

  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const lockPath = path.join(directory, `${endpointLockName(input.host, input.port)}.lock`)
  const invocation = kernelLockInvocation(
    lockPath,
    Math.max(1, Math.ceil(timeoutMs / 1_000)),
    command,
    input.args,
  )
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        ...(input.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const maximumOutputBytes = 16 * 1024
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= maximumOutputBytes) stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= maximumOutputBytes) stderr.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({
      code: Number(code),
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      lockTimedOut: Number(code) === 75,
    }))
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(input.stdin || Buffer.alloc(0))
  })
}
