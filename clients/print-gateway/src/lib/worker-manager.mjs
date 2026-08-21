import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { assertInstanceLedgerCanRun } from './instance-removal.mjs'

const SECRET_PATTERN = /(?:cppair|cpprint)\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gi

function redacted(value) {
  return String(value || '').replaceAll(SECRET_PATTERN, '[secret redacted]').slice(0, 2_000)
}

function runtimeEnvironment(instance, paths, { allowLocalDevelopment = false } = {}) {
  const inherited = {}
  for (const key of [
    'APPDATA',
    'HOME',
    'LANG',
    'LOCALAPPDATA',
    'PATH',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]) {
    if (process.env[key]) inherited[key] = process.env[key]
  }
  return {
    ...inherited,
    ELECTRON_RUN_AS_NODE: '1',
    CLAWPILOT_PRINT_AGENT_URL: instance.baseUrl,
    CLAWPILOT_PRINT_AGENT_CREDENTIAL_FD: '0',
    CLAWPILOT_PRINTER_HOST: instance.printerHost,
    CLAWPILOT_PRINTER_PORT: String(instance.printerPort),
    CLAWPILOT_PRINT_AGENT_POLL_MS: '2000',
    CLAWPILOT_PRINT_AGENT_LEDGER: path.join(paths.instanceDirectory, 'claim-ledger.json'),
    CLAWPILOT_PRINT_AGENT_DEVICE_KEY: path.join(paths.instanceDirectory, 'device-reference.key'),
    CLAWPILOT_PRINT_AGENT_DEVICE_LOCK_DIRECTORY: paths.lockDirectory,
    ...(allowLocalDevelopment ? {
      CLAWPILOT_GATEWAY_TEST_MODE: '1',
      CLAWPILOT_PRINT_AGENT_ALLOW_LOOPBACK: '1',
    } : {}),
  }
}

export function workerLifetimeLockInvocation({
  platform = process.platform,
  lockPath,
  command,
  args,
  macHelperPath,
  windowsHelperPath,
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
          '1',
          '--command',
          command,
          ...args,
        ],
      }
    }
    if (fileExists('/usr/bin/lockf')) {
      return { command: '/usr/bin/lockf', args: ['-t', '0', lockPath, command, ...args] }
    }
  }
  if (platform === 'linux' && fileExists('/usr/bin/flock')) {
    return { command: '/usr/bin/flock', args: ['-F', '-E', '75', '-n', lockPath, command, ...args] }
  }
  if (platform === 'win32') {
    if (!fileExists(windowsHelperPath)) {
      throw new Error('The Windows worker-lifetime lock helper is missing')
    }
    const digest = createHash('sha256')
      .update(`clawpilot:print-worker-lifetime:v1\n${lockPath}`)
      .digest('hex')
    return {
      command: windowsHelperPath,
      args: [
        '--mutex-name',
        `ClawPilotPrintEndpoint_${digest}`,
        '--timeout-ms',
        '1000',
        '--command',
        command,
        '--',
        ...args,
      ],
    }
  }
  throw new Error('A supported kernel worker-lifetime lock is required')
}

export class WorkerManager extends EventEmitter {
  constructor({
    store,
    dataDirectory,
    runtimePath,
    executablePath = process.execPath,
    allowLocalDevelopment = false,
    spawnImplementation = spawn,
    sharedLockDirectory = null,
    startGuard = () => undefined,
  }) {
    super()
    this.store = store
    this.dataDirectory = dataDirectory
    this.runtimePath = runtimePath
    this.executablePath = executablePath
    this.allowLocalDevelopment = allowLocalDevelopment === true
    this.spawnImplementation = spawnImplementation
    this.sharedLockDirectory = sharedLockDirectory
    this.startGuard = startGuard
    this.workers = new Map()
    this.quitting = false
  }

  pathsFor(instance) {
    const lockDirectory = this.sharedLockDirectory || (process.platform === 'darwin'
      ? path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'ClawPilot',
        'print-agent',
        'device-locks',
      )
      : process.platform === 'win32'
        ? path.join(
          os.homedir(),
          'AppData',
          'Local',
          'ClawPilot',
          'print-agent',
          'device-locks',
        )
        : path.join(this.dataDirectory, 'endpoint-locks'))
    return {
      instanceDirectory: path.join(this.dataDirectory, 'instances', instance.slug),
      lockDirectory,
      workerLockPath: path.join(lockDirectory, `worker-${instance.id}.lock`),
    }
  }

  statusFor(id) {
    const state = this.workers.get(id)
    return state ? {
      state: state.state,
      pid: state.runtimePid || state.child?.pid || null,
      startedAt: state.startedAt || null,
      lastEventAt: state.lastEventAt || null,
      lastEvent: state.lastEvent || null,
      lastError: state.lastError || null,
      restartCount: state.restartCount || 0,
    } : {
      state: 'stopped',
      pid: null,
      startedAt: null,
      lastEventAt: null,
      lastEvent: null,
      lastError: null,
      restartCount: 0,
    }
  }

  statuses() {
    return Object.fromEntries(
      this.store.publicState().instances.map((instance) => [instance.id, this.statusFor(instance.id)]),
    )
  }

  emitStatus(id) {
    this.emit('status', { id, status: this.statusFor(id) })
  }

  startEnabled() {
    for (const instance of this.store.publicState().instances) {
      if (instance.enabled) this.start(instance.id)
    }
  }

  start(id) {
    const instance = this.store.instanceFor(id)
    if (!instance || !instance.enabled || this.quitting) return
    const existing = this.workers.get(id)
    if (existing?.child) return
    const paths = this.pathsFor(instance)

    try {
      this.startGuard(instance)
      assertInstanceLedgerCanRun(paths.instanceDirectory)
    } catch (error) {
      const state = existing || { restartCount: 0 }
      state.state = 'stopped'
      state.lastError = redacted(error.message)
      state.lastEventAt = new Date().toISOString()
      this.workers.set(id, state)
      this.emitStatus(id)
      return
    }
    mkdirSync(paths.instanceDirectory, { recursive: true, mode: 0o700 })
    mkdirSync(paths.lockDirectory, { recursive: true, mode: 0o700 })
    let credential
    try {
      credential = this.store.credentialFor(id)
    } catch (error) {
      const state = existing || { restartCount: 0 }
      state.state = 'stopped'
      state.lastError = redacted(error.message)
      state.lastEventAt = new Date().toISOString()
      this.workers.set(id, state)
      this.emitStatus(id)
      return
    }
    const invocation = workerLifetimeLockInvocation({
      lockPath: paths.workerLockPath,
      command: this.executablePath,
      args: [this.runtimePath],
      macHelperPath: path.join(path.dirname(this.runtimePath), 'lib', 'clawpilot-print-lock'),
      windowsHelperPath: path.join(path.dirname(this.runtimePath), 'lib', 'clawpilot-print-lock.exe'),
    })
    const child = this.spawnImplementation(invocation.command, invocation.args, {
      env: runtimeEnvironment(instance, paths, {
        allowLocalDevelopment: this.allowLocalDevelopment,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const state = existing || { restartCount: 0 }
    const generation = (state.generation || 0) + 1
    state.generation = generation
    state.child = child
    state.runtimePid = null
    state.state = 'running'
    state.startedAt = new Date().toISOString()
    state.lastError = null
    state.stopping = false
    this.workers.set(id, state)

    child.stdin.on('error', (error) => {
      if (this.workers.get(id) !== state || state.generation !== generation) return
      if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return
      state.lastError = redacted(error?.message || 'The worker credential pipe failed')
      state.lastEventAt = new Date().toISOString()
      this.emitStatus(id)
    })
    child.stdin.end(`${credential}\n`)
    let stdoutBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer = `${stdoutBuffer}${chunk}`.slice(-65_536)
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event = redacted(line)
        try {
          const parsed = JSON.parse(line)
          event = redacted(parsed.event || line)
          if (
            parsed.event === 'worker_started'
            && Number.isSafeInteger(parsed.pid)
            && parsed.pid > 0
          ) {
            state.runtimePid = parsed.pid
            if (state.stopping) this.signalRuntime(state)
          }
        } catch {
          // Preserve a bounded redacted line for diagnostics.
        }
        state.lastEvent = event
        state.lastEventAt = new Date().toISOString()
        this.emitStatus(id)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      state.lastError = redacted(chunk)
      state.lastEventAt = new Date().toISOString()
      this.emitStatus(id)
    })
    child.once('error', (error) => {
      if (state.generation !== generation || state.child !== child) return
      state.lastError = redacted(error.message)
      this.emitStatus(id)
    })
    child.once('exit', (code, signal) => {
      if (state.generation !== generation || state.child !== child) return
      state.child = null
      state.runtimePid = null
      state.state = state.stopping || this.quitting ? 'stopped' : 'restarting'
      if (!state.stopping && !this.quitting) {
        state.lastError = Number(code) === 75
          ? 'Another ClawPilot process still owns this workspace worker; waiting for it to stop safely'
          : redacted(`Worker exited (${code ?? signal ?? 'unknown'})`)
        state.restartCount += 1
        const delay = Math.min(60_000, 2_000 * (2 ** Math.min(state.restartCount, 5)))
        state.restartTimer = setTimeout(() => this.start(id), delay)
      }
      this.emitStatus(id)
    })
    this.emitStatus(id)
  }

  stop(id) {
    const state = this.workers.get(id)
    if (!state) return
    state.stopping = true
    if (state.restartTimer) clearTimeout(state.restartTimer)
    state.restartTimer = null
    if (state.child) this.signalRuntime(state)
    else state.state = 'stopped'
    this.emitStatus(id)
  }

  signalRuntime(state) {
    if (!state.runtimePid) return
    try {
      process.kill(state.runtimePid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }

  async stopAndWait(id, timeoutMs = 35_000) {
    const state = this.workers.get(id)
    if (!state) return
    if (!state.child) {
      this.stop(id)
      state.state = 'stopped'
      return
    }
    const child = state.child
    const stopped = new Promise((resolvePromise, reject) => {
      let timer
      const finished = () => {
        clearTimeout(timer)
        resolvePromise()
      }
      child.once('exit', finished)
      timer = setTimeout(() => {
        child.removeListener('exit', finished)
        reject(new Error('The background worker did not stop safely; try again after its current job finishes'))
      }, timeoutMs)
    })
    this.stop(id)
    await stopped
  }

  async stopAllAndWait(timeoutMs = 70_000) {
    const results = await Promise.allSettled(
      [...this.workers.keys()].map((id) => this.stopAndWait(id, timeoutMs)),
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  async setEnabled(id, enabled) {
    if (enabled) {
      const instance = this.store.instanceFor(id)
      if (!instance) throw new Error('The local gateway instance was not found')
      this.startGuard(instance)
      assertInstanceLedgerCanRun(this.pathsFor(instance).instanceDirectory)
    }
    this.store.setEnabled(id, enabled)
    if (enabled) this.resume(id)
    else await this.stopAndWait(id)
  }

  resume(id) {
    const state = this.workers.get(id)
    if (state) state.stopping = false
    if (!state?.child) this.start(id)
  }

  forget(id) {
    const state = this.workers.get(id)
    if (state?.child) throw new Error('The background worker must stop before it is removed')
    if (state?.restartTimer) clearTimeout(state.restartTimer)
    this.workers.delete(id)
  }

  shutdown() {
    this.quitting = true
    for (const id of this.workers.keys()) this.stop(id)
  }

  async shutdownAndWait(timeoutMs = 70_000) {
    this.quitting = true
    const active = [...this.workers.entries()]
      .filter(([, state]) => state.child)
      .map(([id]) => this.stopAndWait(id, timeoutMs))
    const results = await Promise.allSettled(active)
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}
