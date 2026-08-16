import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { isIP } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    throw new Error('The local printer LAN IP address is invalid')
  }
  assertPrivateLanPrinterAddress(normalizedHost)
  if (!Number.isSafeInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error('The local printer port is invalid')
  }
  return `${normalizedHost}:${normalizedPort}`
}

export function assertPrivateLanPrinterAddress(value, {
  allowLoopback = process.env.CLAWPILOT_GATEWAY_TEST_MODE === '1'
    && process.env.CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK === '1',
} = {}) {
  const address = String(value || '').trim().toLowerCase()
  if (isIP(address) !== 4 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    throw new Error('The printer must use a literal private LAN IPv4 address')
  }
  const [first, second] = address.split('.').map(Number)
  const privateAddress = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
  const loopback = first === 127
  if (!privateAddress && !(allowLoopback && loopback)) {
    throw new Error('The printer IP must be private LAN space (10/8, 172.16/12, 192.168/16, or 169.254/16)')
  }
  return address
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

export function localPrinterLockInvocation({
  platform = process.platform,
  lockPath,
  timeoutSeconds,
  command,
  args,
  macHelperPath = process.env.CLAWPILOT_MACOS_PRINT_LOCK_HELPER || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'clawpilot-print-lock',
  ),
  windowsHelperPath = process.env.CLAWPILOT_WINDOWS_PRINT_LOCK_HELPER || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'clawpilot-print-lock.exe',
  ),
  fileExists = existsSync,
}) {
  if (platform === 'darwin') {
    if (fileExists(macHelperPath)) {
      return {
        command: macHelperPath,
        args: [
          '--lock-path',
          lockPath,
          '--timeout-ms',
          String(timeoutSeconds * 1_000),
          '--command',
          command,
          ...args,
        ],
      }
    }
    if (fileExists('/usr/bin/lockf')) {
      return {
        command: '/usr/bin/lockf',
        args: ['-t', String(timeoutSeconds), lockPath, command, ...args],
      }
    }
  }
  if (platform === 'linux' && fileExists('/usr/bin/flock')) {
    return {
      command: '/usr/bin/flock',
      args: ['-E', '75', '-w', String(timeoutSeconds), lockPath, command, ...args],
    }
  }
  if (platform === 'win32') {
    if (!fileExists(windowsHelperPath)) {
      throw new Error('The Windows print-endpoint lock helper is missing')
    }
    const mutexName = `ClawPilotPrintEndpoint_${path.win32.basename(lockPath, '.lock')}`
    return {
      command: windowsHelperPath,
      args: [
        '--mutex-name',
        mutexName,
        '--timeout-ms',
        String(timeoutSeconds * 1_000),
        '--command',
        command,
        '--',
        ...args,
      ],
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
  const invocation = localPrinterLockInvocation({
    lockPath,
    timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1_000)),
    command,
    args: input.args,
  })
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        // The packaged worker is itself running under Electron's Node mode,
        // but Electron removes this variable from its own environment. The
        // trusted nested raw-delivery helper must always re-enter Node mode;
        // otherwise the Electron binary launches a GUI app under lockf/flock
        // and can hold the endpoint lock indefinitely without delivering.
        ELECTRON_RUN_AS_NODE: '1',
        ...(process.env.CLAWPILOT_GATEWAY_TEST_MODE === '1'
          && process.env.CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK === '1'
          ? {
            CLAWPILOT_GATEWAY_TEST_MODE: '1',
            CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK: '1',
          }
          : {}),
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
