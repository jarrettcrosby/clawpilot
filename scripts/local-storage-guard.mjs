#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const GIB = 1024 ** 3
const DEFAULT_MIN_FREE_GIB = 15
const DEFAULT_WARN_FREE_GIB = 25
export const GENERATED_ARTIFACT_PATHS = Object.freeze([
  'node_modules',
  'app_src/node_modules',
  'app_src/.next',
  'app_src/coverage',
  'app_src/out',
  'app_src/build',
  'app_src/test-results',
  'app_src/playwright-report',
  'shopify/node_modules',
  'clients/apple/.build',
  'clients/apple/.swiftpm',
  'clients/apple/build',
  'clients/apple/.artifacts',
  'output',
  'tmp',
])

const hasValue = (value) => String(value ?? '').trim().length > 0
const isTrue = (value) => /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim())

export function detectHostedEnvironment(environment = process.env) {
  if (isTrue(environment.CI)) return 'CI'
  if ([
    'RAILWAY_PROJECT_ID',
    'RAILWAY_ENVIRONMENT_ID',
    'RAILWAY_ENVIRONMENT_NAME',
    'RAILWAY_SERVICE_ID',
  ].some((name) => hasValue(environment[name]))) return 'Railway'
  if (isTrue(environment.VERCEL) || hasValue(environment.VERCEL_ENV)) return 'Vercel'
  return null
}

function positiveGiB(raw, name, fallback) {
  if (!hasValue(raw)) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of GiB`)
  return value
}

export function readThresholds(environment = process.env) {
  const minimumGiB = positiveGiB(
    environment.CLAWPILOT_MIN_FREE_GIB,
    'CLAWPILOT_MIN_FREE_GIB',
    DEFAULT_MIN_FREE_GIB,
  )
  const warningGiB = positiveGiB(
    environment.CLAWPILOT_WARN_FREE_GIB,
    'CLAWPILOT_WARN_FREE_GIB',
    DEFAULT_WARN_FREE_GIB,
  )
  if (warningGiB < minimumGiB) {
    throw new Error('CLAWPILOT_WARN_FREE_GIB must be greater than or equal to CLAWPILOT_MIN_FREE_GIB')
  }
  return { minimumGiB, warningGiB, minimumBytes: minimumGiB * GIB, warningBytes: warningGiB * GIB }
}

export function assessHeadroom(availableBytes, thresholds) {
  if (availableBytes < thresholds.minimumBytes) return 'fail'
  return availableBytes < thresholds.warningBytes ? 'warn' : 'ok'
}

function diskSpace(path) {
  const stats = statfsSync(path, { bigint: true })
  return {
    availableBytes: Number(stats.bavail * stats.bsize),
    totalBytes: Number(stats.blocks * stats.bsize),
  }
}

export function parseWorktreePorcelain(output) {
  const records = []
  let current = null
  const finish = () => {
    if (current?.path) records.push(current)
    current = null
  }
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) {
      finish()
      continue
    }
    const [field, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (field === 'worktree') {
      finish()
      current = { path: value, prunable: false }
    } else if (current && field === 'prunable') current.prunable = true
  }
  finish()
  return records
}

function registeredWorktrees(repositoryRoot) {
  return parseWorktreePorcelain(execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }))
}

function allocatedBytes(path) {
  const output = execFileSync('du', ['-sk', path], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  const kibibytes = Number.parseInt(output.trim().split(/\s+/, 1)[0], 10)
  if (!Number.isFinite(kibibytes)) throw new Error(`Unable to measure ${path}`)
  return kibibytes * 1024
}

export function collectGeneratedArtifacts(
  roots,
  { pathExists = existsSync, measure = allocatedBytes } = {},
) {
  const seen = new Set()
  const artifacts = []
  for (const root of roots) {
    for (const relativePath of GENERATED_ARTIFACT_PATHS) {
      const path = resolve(root, relativePath)
      if (seen.has(path) || !pathExists(path)) continue
      seen.add(path)
      try {
        artifacts.push({ path, allocatedBytes: measure(path) })
      } catch (error) {
        artifacts.push({ path, allocatedBytes: null, error: String(error?.message ?? error) })
      }
    }
  }
  return artifacts.sort((left, right) => (right.allocatedBytes ?? -1) - (left.allocatedBytes ?? -1))
}

function errorSummary(error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? String(error.stderr ?? '').trim()
    : ''
  return (stderr || String(error?.message ?? error)).split(/\r?\n/).find(Boolean)?.slice(0, 500) || 'unknown error'
}

export function parseDockerSystemDf(output) {
  return String(output).trim().split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(/\s{2,}/))
    .filter((columns) => columns.length >= 5)
    .map(([type, total, active, size, reclaimable]) => ({
      type,
      total: Number.parseInt(total, 10) || 0,
      active: Number.parseInt(active, 10) || 0,
      size,
      reclaimable,
    }))
}

export function collectDockerSummary(execute = execFileSync) {
  let output
  const options = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10_000 }
  try {
    output = execute('docker', ['system', 'df'], options)
  } catch (error) {
    return { available: false, error: errorSummary(error) }
  }
  try {
    const volumes = execute('docker', ['volume', 'ls', '-q'], options)
    return {
      available: true,
      volumeCount: String(volumes).split(/\r?\n/).filter(Boolean).length,
      systemDf: parseDockerSystemDf(output),
    }
  } catch (error) {
    return { available: true, volumeCount: null, volumeError: errorSummary(error), systemDf: parseDockerSystemDf(output) }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(2)} ${units[unit]}`
}

function printPreflight(root, space, thresholds, write, writeError) {
  const status = assessHeadroom(space.availableBytes, thresholds)
  const detail = `available=${formatBytes(space.availableBytes)} minimum=${thresholds.minimumGiB} GiB ` +
    `warning=${thresholds.warningGiB} GiB root=${root}`
  if (status === 'fail') {
    writeError(`LOCAL_STORAGE_PREFLIGHT_FAILED ${detail}\n`)
    writeError('Run npm run storage:audit to inspect likely local consumers. No files were removed.\n')
    return 1
  }
  write(`LOCAL_STORAGE_PREFLIGHT_${status === 'warn' ? 'WARNING' : 'OK'} ${detail}\n`)
  if (status === 'warn') write('Local startup may continue, but available space is below the warning threshold.\n')
  return 0
}

function allocation(label, path) {
  if (!existsSync(path)) return null
  try {
    return `${label} allocated=${formatBytes(allocatedBytes(path))} path=${path}`
  } catch (error) {
    return `${label} error=${errorSummary(error)} path=${path}`
  }
}

function printAudit(root, space, thresholds, write) {
  let worktrees = []
  let worktreeError = null
  try {
    worktrees = registeredWorktrees(root)
  } catch (error) {
    worktreeError = errorSummary(error)
  }
  const roots = [...new Set(worktrees.filter(({ path }) => existsSync(path)).map(({ path }) => realpathSync(path)))]
  if (!roots.length) roots.push(root)
  const artifacts = collectGeneratedArtifacts(roots)
  const docker = collectDockerSummary()

  write('CLAWPILOT_LOCAL_STORAGE_AUDIT\npolicy=report-only; no files were removed\n')
  write(`repository=${root}\n`)
  write(`filesystem=${formatBytes(space.availableBytes)} available of ${formatBytes(space.totalBytes)} ` +
    `(status=${assessHeadroom(space.availableBytes, thresholds)}; fail below ${thresholds.minimumGiB} GiB; ` +
    `warn below ${thresholds.warningGiB} GiB)\n`)
  write(`worktrees=${worktrees.length} registered, ${roots.length} existing, ` +
    `${worktrees.filter(({ path }) => !existsSync(path)).length} missing, ` +
    `${worktrees.filter(({ prunable }) => prunable).length} marked prunable\n`)
  if (worktreeError) write(`worktree_inventory_error=${worktreeError}\n`)
  write(`generated_artifacts=${artifacts.length} found, ` +
    `${formatBytes(artifacts.reduce((sum, artifact) => sum + (artifact.allocatedBytes ?? 0), 0))} allocated\n`)
  for (const artifact of artifacts.slice(0, 15)) write(`  ${formatBytes(artifact.allocatedBytes)}  ${artifact.path}\n`)
  if (artifacts.length > 15) write(`  ... ${artifacts.length - 15} additional generated paths omitted\n`)
  for (const result of [
    allocation('npm_cache', process.env.npm_config_cache || join(homedir(), '.npm')),
    allocation('docker_disk_image', join(homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw')),
  ].filter(Boolean)) write(`${result}\n`)
  if (docker.available) {
    write(`docker=available volumes=${docker.volumeCount ?? 'unknown'}\n`)
    for (const row of docker.systemDf) {
      write(`  docker_system_df type=${row.type} total=${row.total} active=${row.active} ` +
        `size=${row.size} reclaimable=${row.reclaimable}\n`)
    }
    if (docker.volumeError) write(`docker_volume_count_error=${docker.volumeError}\n`)
  } else write(`docker=unavailable error=${docker.error}\n`)
  write('Review the inventory before any scoped cleanup. This command never deletes or prunes data.\n')
}

export function runStorageGuard({
  argv = process.argv.slice(2),
  environment = process.env,
  repositoryRoot = process.cwd(),
  write = (message) => process.stdout.write(message),
  writeError = (message) => process.stderr.write(message),
  readSpace = diskSpace,
} = {}) {
  const unknown = argv.filter((argument) => !['--preflight', '--help', '-h'].includes(argument))
  if (unknown.length) {
    writeError(`Unknown argument: ${unknown[0]}\n`)
    return 2
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    write('Usage: node scripts/local-storage-guard.mjs [--preflight]\n')
    return 0
  }
  const mode = argv.includes('--preflight') ? 'PREFLIGHT' : 'AUDIT'
  const hosted = detectHostedEnvironment(environment)
  if (hosted) {
    write(`LOCAL_STORAGE_${mode}_SKIPPED hosted=${hosted} policy=local-only\n`)
    return 0
  }
  try {
    const root = realpathSync(repositoryRoot)
    const thresholds = readThresholds(environment)
    const space = readSpace(root)
    if (mode === 'PREFLIGHT') return printPreflight(root, space, thresholds, write, writeError)
    printAudit(root, space, thresholds, write)
    return 0
  } catch (error) {
    writeError(`LOCAL_STORAGE_GUARD_ERROR ${errorSummary(error)}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runStorageGuard()
}
