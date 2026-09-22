import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as filesystem from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runStorageGuard } from '../local-storage-guard.mjs'

const POSTGRES_IMAGE = /^(?:pgvector\/pgvector:pg|postgres:)(16|18)(?:-|$)/u
const TMPFS_SIZE = /^[1-9]\d*[bkmg]?$/iu

export const DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV = 'CLAWPILOT_TEST_POSTGRES_TMPFS_SIZE'

const configuredTmpfsSize = process.env[DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV]?.trim()
if (configuredTmpfsSize && !TMPFS_SIZE.test(configuredTmpfsSize)) {
  throw new Error(
    `${DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV} must be a positive byte count with an optional b, k, m, or g suffix`,
  )
}

export const DISPOSABLE_POSTGRES_TMPFS_SIZE = configuredTmpfsSize || '4g'

const DOCKER_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u
export const DISPOSABLE_POSTGRES_LABEL = 'com.clawpilot.disposable-postgres'
export const DISPOSABLE_POSTGRES_OWNER_LABEL = `${DISPOSABLE_POSTGRES_LABEL}.owner`
const GIB = 1024 ** 3
const MIB = 1024 ** 2
const OWNED_OPTIONS = new Set([
  '--tmpfs', '--memory', '-m', '--memory-swap', '--memory-reservation',
  '--memory-swappiness', '--cpus', '--cpu-quota', '--cpu-period', '--cpuset-cpus',
  '--pids-limit', '--log-driver', '--log-opt', '--label', '-l', '--label-file',
  '--mount', '--volume', '-v', '--volumes-from', '--privileged', '--oom-kill-disable',
])

function boundedBytes(raw, name, fallback, minimum, maximum) {
  const value = String(raw ?? fallback).trim()
  if (!TMPFS_SIZE.test(value)) throw new Error(`${name} must be a positive byte count`)
  const suffix = value.at(-1).toLowerCase()
  const multiplier = { b: 1, k: 1024, m: MIB, g: GIB }[suffix] ?? 1
  const bytes = Number.parseInt(value, 10) * multiplier
  if (!Number.isSafeInteger(bytes) || bytes < minimum || bytes > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} bytes`)
  }
  return { value, bytes }
}

export function disposablePostgresResourceLimits(environment = process.env) {
  const tmpfs = boundedBytes(environment[DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV],
    DISPOSABLE_POSTGRES_TMPFS_SIZE_ENV, '4g', 16 * MIB, 4 * GIB)
  // Keep the established 4 GiB test data ceiling plus 1 GiB for PostgreSQL itself.
  // Equal memory and memory-swap limits prohibit additional swap allocation.
  const memory = boundedBytes(environment.CLAWPILOT_TEST_POSTGRES_MEMORY,
    'CLAWPILOT_TEST_POSTGRES_MEMORY', '5g', 256 * MIB, 5 * GIB)
  if (memory.bytes < tmpfs.bytes + 128 * MIB) {
    throw new Error('Disposable PostgreSQL memory must leave at least 128 MiB beyond tmpfs')
  }
  const cpus = Number(environment.CLAWPILOT_TEST_POSTGRES_CPUS ?? 2)
  if (!Number.isFinite(cpus) || cpus < 0.25 || cpus > 2) {
    throw new Error('CLAWPILOT_TEST_POSTGRES_CPUS must be between 0.25 and 2')
  }
  return { tmpfs: tmpfs.value, memory: memory.value, cpus: String(cpus) }
}

function localHeadroom(environment, repositoryRoot) {
  // railway run and CI=true still execute locally on a Mac. Do not let their
  // inherited provider variables skip the local filesystem check.
  const localEnvironment = { ...environment, CI: '', VERCEL: '', VERCEL_ENV: '' }
  for (const key of [
    'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID',
    'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_SERVICE_ID',
  ]) delete localEnvironment[key]
  let diagnostic = ''
  const code = runStorageGuard({
    argv: ['--preflight'], environment: localEnvironment, repositoryRoot,
    write: () => {}, writeError: (message) => { diagnostic += message },
  })
  if (code !== 0) throw new Error(diagnostic.trim() || 'Local Docker storage preflight failed')
}

export function createDisposablePostgresRuntime({
  platform = process.platform,
  environment = process.env,
  repositoryRoot = process.cwd(),
  leasePath = join(homedir(), '.cache/clawpilot/disposable-postgres/active'),
  fs = filesystem,
  execute = execFileSync,
  lifecycle = process,
  pid = process.pid,
  token = randomUUID(),
  checkHeadroom = localHeadroom,
  isProcessAlive = (candidate) => {
    try { process.kill(candidate, 0); return true } catch (error) {
      if (error.code === 'ESRCH') return false
      // Lack of permission is not evidence that a process has exited.
      return true
    }
  },
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const tracked = new Map()
  let handlersInstalled = false
  let shuttingDown = false
  const commandOptions = {
    encoding: 'utf8', timeout: 10_000, maxBuffer: MIB, stdio: ['ignore', 'pipe', 'pipe'],
  }
  const ownerPath = join(leasePath, 'owner.json')
  const reaperPath = `${leasePath}.recovery`

  function inspect(name) {
    try {
      const output = execute('docker', [
        'container', 'inspect', '--format',
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', name,
      ], commandOptions)
      const container = JSON.parse(String(output))
      if (!/^[a-f0-9]{64}$/u.test(container?.id ?? '')
        || (container.labels !== null
          && (typeof container.labels !== 'object' || Array.isArray(container.labels)))) {
        throw new Error('Invalid Docker ownership response')
      }
      return { id: container.id, labels: container.labels ?? {} }
    } catch (error) {
      if (/No such (?:object|container):/i.test(String(error.stderr ?? ''))) return null
      throw new Error(`Cannot verify disposable Docker container ${name}; admission/cleanup stopped`)
    }
  }

  function readOwner() {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== 'string' || !owner.token
        || !DOCKER_CONTAINER_NAME.test(owner.name ?? '')) throw new Error('invalid owner')
      return owner
    } catch {
      throw new Error(`Disposable PostgreSQL lease is incomplete; inspect ${leasePath} before retrying`)
    }
  }

  function removeLease(expectedToken) {
    const owner = readOwner()
    if (owner.token !== expectedToken) throw new Error('Disposable PostgreSQL lease owner changed')
    fs.unlinkSync(ownerPath)
    fs.rmdirSync(leasePath)
  }

  function claimLease(name) {
    fs.mkdirSync(dirname(leasePath), { recursive: true, mode: 0o700 })
    if (fs.existsSync(reaperPath)) throw new Error('Disposable PostgreSQL lease recovery is in progress')
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // Serialize stale-lease recovery separately. Never reclaim a live owner,
      // an unknown state, or a lease whose container still exists.
      try { fs.mkdirSync(reaperPath, { mode: 0o700 }) } catch {
        throw new Error('Another disposable PostgreSQL admission/recovery is in progress')
      }
      try {
        const owner = readOwner()
        if (isProcessAlive(owner.pid)) {
          throw new Error(`Disposable PostgreSQL is already reserved by process ${owner.pid} (${owner.name}); wait for it to finish`)
        }
        if (inspect(owner.name) !== null) {
          throw new Error(`Previous disposable PostgreSQL container ${owner.name} still exists; inspect it before retrying`)
        }
        removeLease(owner.token)
        // Claim while holding the recovery mutex. A racing normal claimant
        // either wins this mkdir or receives EEXIST; neither can share a lease.
        fs.mkdirSync(leasePath, { mode: 0o700 })
      } finally {
        fs.rmdirSync(reaperPath)
      }
    }
    fs.writeFileSync(ownerPath, JSON.stringify({ pid, token, name }), { flag: 'wx', mode: 0o600 })
  }

  function cleanup() {
    let complete = true
    for (const [name, record] of tracked) {
      try {
        const container = inspect(name)
        if (container !== null) {
          const { id, labels } = container
          if (labels[DISPOSABLE_POSTGRES_LABEL] !== 'true'
            || labels[DISPOSABLE_POSTGRES_OWNER_LABEL] !== token) {
            throw new Error(`Ownership mismatch for ${name}; container was left untouched`)
          }
          // Names can be reused after --rm. Remove only the immutable ID whose
          // ownership was verified, never a replacement using the same name.
          try {
            execute('docker', disposablePostgresDockerCleanupArgs(id), commandOptions)
          } catch {
            // --rm may already have removed this exact ID. Only confirmed
            // absence makes that race successful; daemon errors stay closed.
            if (inspect(id) !== null) throw new Error(`Unable to remove owned container ${name}`)
          }
          if (inspect(id) !== null) throw new Error(`Container ${name} still exists after cleanup`)
        }
        if (record.leased) removeLease(token)
        tracked.delete(name)
      } catch (error) {
        complete = false
        warn(`Disposable PostgreSQL cleanup needs review: ${error.message}`)
      }
    }
    return complete
  }

  function installHandlers() {
    if (handlersInstalled) return
    handlersInstalled = true
    lifecycle.once('exit', () => { if (!shuttingDown) cleanup() })
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      lifecycle.once(signal, () => {
        shuttingDown = true
        cleanup()
        lifecycle.exit(code)
      })
    }
  }

  function admit(name) {
    if (shuttingDown) throw new Error('Disposable PostgreSQL process is shutting down')
    const localMac = platform === 'darwin'
    if (localMac) checkHeadroom(environment, repositoryRoot)
    if (tracked.has(name)) throw new Error(`Disposable PostgreSQL name ${name} is already tracked`)
    if (localMac && tracked.size) {
      // A process may run sequential fixtures. Release only a previous fixture
      // that the caller already stopped; do not stop it to admit another one.
      for (const [previous, record] of tracked) {
        if (inspect(previous) !== null) throw new Error(`Disposable PostgreSQL ${previous} is still present`)
        if (record.leased) removeLease(token)
        tracked.delete(previous)
      }
    }
    if (inspect(name) !== null) throw new Error(`Docker container ${name} already exists; it was left untouched`)
    if (localMac) claimLease(name)
    tracked.set(name, { leased: localMac })
    installHandlers()
    return token
  }
  return { admit, cleanup }
}

let defaultRuntime

export function disposablePostgresDockerArgs(args, {
  environment = process.env,
  runtime,
} = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('Disposable PostgreSQL Docker arguments must be an array')
  }

  const action = args[0]
  if (action !== 'run' && action !== 'create') {
    throw new Error('Disposable PostgreSQL Docker action must be run or create')
  }

  const imageIndex = args.findIndex((argument) => (
    typeof argument === 'string' && POSTGRES_IMAGE.test(argument)
  ))
  if (imageIndex < 0) {
    throw new Error('Disposable PostgreSQL Docker image must be PostgreSQL 16 or 18')
  }

  const image = args[imageIndex]
  const major = image.match(POSTGRES_IMAGE)?.[1]
  const dataPath = major === '18'
    ? '/var/lib/postgresql'
    : '/var/lib/postgresql/data'
  const limits = disposablePostgresResourceLimits(environment)
  const tmpfs = `${dataPath}:rw,size=${limits.tmpfs},mode=1777`
  const guarded = [...args]

  const options = guarded.slice(1, imageIndex)
  for (const argument of options) {
    if (typeof argument !== 'string') throw new TypeError('Disposable PostgreSQL options must be strings')
    if (OWNED_OPTIONS.has(argument.split('=', 1)[0]) || /^-[mlv].+/u.test(argument)) {
      throw new Error(`Disposable PostgreSQL resource/storage option ${argument.split('=', 1)[0]} is owned by the Docker argument guard`)
    }
  }
  const nameIndices = options.flatMap((option, index) => option === '--name' ? [index] : [])
  if (nameIndices.length !== 1 || options.some((option) => option.startsWith('--name='))) {
    throw new Error('Disposable PostgreSQL requires one exact --name argument')
  }
  const name = options[nameIndices[0] + 1]
  if (typeof name !== 'string' || !DOCKER_CONTAINER_NAME.test(name)) {
    throw new Error('Disposable PostgreSQL requires one exact safe container name')
  }
  const activeRuntime = runtime ?? (defaultRuntime ??= createDisposablePostgresRuntime())
  const ownerToken = activeRuntime.admit(name)

  if (!guarded.slice(1, imageIndex).includes('--rm')) {
    guarded.splice(1, 0, '--rm')
  }

  const guardedImageIndex = guarded.indexOf(image)
  guarded.splice(guardedImageIndex, 0,
    '--tmpfs', tmpfs,
    '--memory', limits.memory, '--memory-swap', limits.memory,
    '--cpus', limits.cpus, '--pids-limit', '256',
    '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '--label', `${DISPOSABLE_POSTGRES_LABEL}=true`,
    '--label', `${DISPOSABLE_POSTGRES_OWNER_LABEL}=${ownerToken}`,
  )
  return guarded
}

export function disposablePostgresDockerCleanupArgs(containerName) {
  if (
    typeof containerName !== 'string'
    || !DOCKER_CONTAINER_NAME.test(containerName)
  ) {
    throw new Error('Disposable PostgreSQL cleanup requires one exact Docker container name')
  }

  return ['rm', '--force', '--volumes', containerName]
}
