#!/usr/bin/env node

import assert from 'node:assert/strict'
import { evaluateBackupState, parseArgs } from './railway-backup-audit.mjs'

const options = parseArgs([
  '--project-id',
  'project-1',
  '--environment',
  'development,production,development',
  '--required-schedules',
  'daily,weekly',
  '--max-age-hours',
  '30',
], {})

assert.deepEqual(options.environments, ['development', 'production'])
assert.deepEqual(options.requiredSchedules, ['DAILY', 'WEEKLY'])
assert.equal(options.maxAgeHours, 30)
assert.equal(options.projectId, 'project-1')

const baseVolume = {
  environmentId: 'environment-1',
  service: 'Postgres',
  serviceId: 'service-1',
  volume: 'postgres-volume',
  volumeId: 'volume-1',
  volumeInstanceId: 'volume-instance-1',
  mountPath: '/var/lib/postgresql/data',
  capacityMB: 5000,
  currentSizeMB: 220,
  state: 'READY',
  schedules: [
    { id: 'daily', kind: 'DAILY' },
    { id: 'weekly', kind: 'WEEKLY' },
  ],
  backups: [
    { id: 'backup-1', createdAt: '2026-07-13T12:00:00.000Z' },
  ],
}

const healthy = evaluateBackupState({
  observedAt: '2026-07-13T13:00:00.000Z',
  project: 'clawpilot',
  projectId: 'project-1',
  environments: [
    { ...baseVolume, environment: 'development' },
    { ...baseVolume, environment: 'production', environmentId: 'environment-2' },
  ],
}, options, new Date('2026-07-13T13:00:00.000Z'))

assert.equal(healthy.healthy, true)
assert.equal(healthy.environments[0].latestBackupAgeHours, 1)
assert.deepEqual(healthy.environments[0].violations, [])

const unhealthy = evaluateBackupState({
  observedAt: '2026-07-14T20:00:00.000Z',
  project: 'clawpilot',
  projectId: 'project-1',
  environments: [
    {
      ...baseVolume,
      environment: 'development',
      schedules: [{ id: 'daily', kind: 'DAILY' }],
      backups: [],
    },
    { environment: 'production', missing: true },
  ],
}, options, new Date('2026-07-14T20:00:00.000Z'))

assert.equal(unhealthy.healthy, false)
assert.deepEqual(unhealthy.environments[0].violations, [
  'Missing schedules: WEEKLY',
  'No Railway provider backup record exists',
])
assert.deepEqual(unhealthy.environments[1].violations, [
  'Environment or Postgres volume instance not found',
])

assert.throws(
  () => parseArgs(['--project-id', 'project-1', '--max-age-hours', '0'], {}),
  /positive number/,
)
assert.throws(
  () => parseArgs(['--project-id', 'project-1', '--required-schedules', 'hourly'], {}),
  /Unsupported backup schedule/,
)

console.log('Railway backup audit tests passed')
