#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const DEFAULT_ENDPOINT = 'https://backboard.railway.com/graphql/v2'
const DEFAULT_ENVIRONMENTS = ['development', 'production']
const DEFAULT_REQUIRED_SCHEDULES = ['DAILY', 'WEEKLY', 'MONTHLY']
const DEFAULT_MAX_AGE_HOURS = 30
const VALID_SCHEDULES = new Set(['DAILY', 'WEEKLY', 'MONTHLY'])

function readOption(argv, index, option) {
  const value = argv[index + 1]?.trim()
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function parseList(value) {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
}

export function parseArgs(argv, env = process.env) {
  const options = {
    endpoint: env.RAILWAY_API_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    environments: DEFAULT_ENVIRONMENTS,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    projectId: env.RAILWAY_PROJECT_ID?.trim() || '',
    requiredSchedules: DEFAULT_REQUIRED_SCHEDULES,
    serviceName: 'Postgres',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { ...options, help: true }
    if (option === '--project-id') {
      options.projectId = readOption(argv, index, option)
      index += 1
      continue
    }
    if (option === '--environment') {
      options.environments = parseList(readOption(argv, index, option))
      index += 1
      continue
    }
    if (option === '--service') {
      options.serviceName = readOption(argv, index, option)
      index += 1
      continue
    }
    if (option === '--required-schedules') {
      options.requiredSchedules = parseList(readOption(argv, index, option)).map((kind) => kind.toUpperCase())
      index += 1
      continue
    }
    if (option === '--max-age-hours') {
      options.maxAgeHours = Number(readOption(argv, index, option))
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${option}`)
  }

  if (!options.projectId) throw new Error('Set RAILWAY_PROJECT_ID or pass --project-id')
  if (options.environments.length === 0) throw new Error('At least one environment is required')
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a positive number')
  }
  for (const kind of options.requiredSchedules) {
    if (!VALID_SCHEDULES.has(kind)) throw new Error(`Unsupported backup schedule: ${kind}`)
  }
  return options
}

function graphqlError(result, status) {
  const messages = result?.errors?.map((error) => {
    const trace = error.traceId ? `, trace ${error.traceId}` : ''
    return `${error.message}${trace}`
  })
  return new Error(messages?.join('; ') || `Railway API request failed with HTTP ${status}`)
}

async function requestGraphql({ endpoint, token, query, variables, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  if (!response.ok || result.errors) throw graphqlError(result, response.status)
  return result.data
}

const PROJECT_QUERY = `
  query BackupAuditProject($projectId: String!) {
    project(id: $projectId) {
      id
      name
      environments(first: 50) {
        edges {
          node {
            id
            name
            volumeInstances(first: 50) {
              edges {
                node {
                  id
                  mountPath
                  sizeMB
                  currentSizeMB
                  state
                  volume { id name }
                  service { id name }
                }
              }
            }
          }
        }
      }
    }
  }
`

const BACKUP_QUERY = `
  query BackupAuditVolume($volumeInstanceId: String!) {
    backups: volumeInstanceBackupList(volumeInstanceId: $volumeInstanceId) {
      id
      name
      createdAt
      expiresAt
      scheduleId
      usedMB
      referencedMB
      volumeInstanceSizeMB
    }
    schedules: volumeInstanceBackupScheduleList(volumeInstanceId: $volumeInstanceId) {
      id
      name
      kind
      cron
      retentionSeconds
      createdAt
    }
  }
`

export async function readBackupState(options, dependencies = {}) {
  const token = dependencies.token || process.env.RAILWAY_API_TOKEN?.trim()
  if (!token) throw new Error('Set RAILWAY_API_TOKEN to an account or workspace API token')

  const request = dependencies.request || ((query, variables) => requestGraphql({
    endpoint: options.endpoint,
    token,
    query,
    variables,
    fetchImpl: dependencies.fetchImpl,
  }))
  const projectData = await request(PROJECT_QUERY, { projectId: options.projectId })
  const environmentsByName = new Map(
    projectData.project.environments.edges.map(({ node }) => [node.name, node]),
  )
  const environments = []

  for (const environmentName of options.environments) {
    const environment = environmentsByName.get(environmentName)
    if (!environment) {
      environments.push({ environment: environmentName, missing: true })
      continue
    }
    const matches = environment.volumeInstances.edges
      .map(({ node }) => node)
      .filter((volume) => volume.service.name === options.serviceName)
    if (matches.length !== 1) {
      environments.push({
        environment: environment.name,
        environmentId: environment.id,
        missing: true,
        reason: `Expected one ${options.serviceName} volume instance; found ${matches.length}`,
      })
      continue
    }

    const volume = matches[0]
    const backupData = await request(BACKUP_QUERY, { volumeInstanceId: volume.id })
    environments.push({
      environment: environment.name,
      environmentId: environment.id,
      service: volume.service.name,
      serviceId: volume.service.id,
      volume: volume.volume.name,
      volumeId: volume.volume.id,
      volumeInstanceId: volume.id,
      mountPath: volume.mountPath,
      capacityMB: volume.sizeMB,
      currentSizeMB: volume.currentSizeMB,
      state: volume.state,
      schedules: backupData.schedules,
      backups: backupData.backups,
    })
  }

  return {
    observedAt: new Date().toISOString(),
    project: projectData.project.name,
    projectId: projectData.project.id,
    environments,
  }
}

export function evaluateBackupState(state, options, now = new Date()) {
  const nowMs = now.getTime()
  const environments = state.environments.map((environment) => {
    const violations = []
    if (environment.missing) {
      violations.push(environment.reason || 'Environment or Postgres volume instance not found')
      return { ...environment, healthy: false, violations }
    }

    const scheduleKinds = new Set(environment.schedules.map((schedule) => schedule.kind))
    const missingSchedules = options.requiredSchedules.filter((kind) => !scheduleKinds.has(kind))
    if (missingSchedules.length > 0) {
      violations.push(`Missing schedules: ${missingSchedules.join(', ')}`)
    }

    const backupTimes = environment.backups
      .map((backup) => ({ backup, time: Date.parse(backup.createdAt) }))
      .filter(({ time }) => Number.isFinite(time))
      .sort((left, right) => right.time - left.time)
    const latest = backupTimes[0]
    const latestBackupAgeHours = latest ? (nowMs - latest.time) / 3_600_000 : null
    if (!latest) {
      violations.push('No Railway provider backup record exists')
    } else if (latestBackupAgeHours < 0) {
      violations.push('Latest backup timestamp is in the future')
    } else if (latestBackupAgeHours > options.maxAgeHours) {
      violations.push(`Latest backup is ${latestBackupAgeHours.toFixed(1)} hours old`)
    }

    return {
      ...environment,
      latestBackupAt: latest?.backup.createdAt || null,
      latestBackupAgeHours,
      healthy: violations.length === 0,
      violations,
    }
  })

  return {
    ...state,
    policy: {
      environments: options.environments,
      maxBackupAgeHours: options.maxAgeHours,
      requiredSchedules: options.requiredSchedules,
      serviceName: options.serviceName,
    },
    healthy: environments.length === options.environments.length
      && environments.every((environment) => environment.healthy),
    environments,
  }
}

function usage() {
  return `Usage: node scripts/railway-backup-audit.mjs --project-id <id> [options]

Environment:
  RAILWAY_API_TOKEN       Account or workspace API token (required)
  RAILWAY_PROJECT_ID      Project ID (alternative to --project-id)
  RAILWAY_API_ENDPOINT    GraphQL endpoint override

Options:
  --environment <names>           Comma-separated names (default: development,production)
  --service <name>                Database service name (default: Postgres)
  --required-schedules <kinds>    Comma-separated kinds (default: DAILY,WEEKLY,MONTHLY)
  --max-age-hours <hours>         Maximum provider backup age (default: 30)
  --help                          Show this help
`
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }
  const state = await readBackupState(options)
  const evaluated = evaluateBackupState(state, options)
  process.stdout.write(`${JSON.stringify(evaluated, null, 2)}\n`)
  return evaluated.healthy ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`Railway backup audit failed: ${error.message}`)
    process.exitCode = 2
  })
}
