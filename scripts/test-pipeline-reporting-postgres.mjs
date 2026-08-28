#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { normalizePipelineReportingSnapshot } from '../app_src/lib/pipeline/reportingSnapshot.mjs'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const ts = requireFromApp('typescript')
const disposablePostgresImage = String(
  process.env.CLAWPILOT_TEST_POSTGRES_IMAGE || 'pgvector/pgvector:pg16',
).trim()

assert.ok(
  ['pgvector/pgvector:pg16', 'pgvector/pgvector:pg18'].includes(disposablePostgresImage),
  'CLAWPILOT_TEST_POSTGRES_IMAGE must select the exact pg16 or pg18 image',
)

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_000,
      max: 1,
    })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function loadCrmPersistence(pool) {
  const path = 'app_src/lib/persistence/crm.ts'
  const output = ts.transpileModule(readFileSync(resolve(root, path), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: path,
  }).outputText
  const module = { exports: {} }
  const emptyDependency = new Proxy({}, {
    get() {
      return () => undefined
    },
  })

  vm.runInNewContext(output, {
    Buffer,
    Date,
    Error,
    Intl,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    console,
    exports: module.exports,
    module,
    process,
    require(specifier) {
      if (specifier === 'node:crypto') return requireFromApp(specifier)
      if (specifier === '@/lib/persistence/postgres') {
        return {
          query(text, values = []) {
            return pool.query(text, values)
          },
          async withTransaction(callback) {
            const client = await pool.connect()
            try {
              await client.query('BEGIN')
              const result = await callback(client)
              await client.query('COMMIT')
              return result
            } catch (error) {
              await client.query('ROLLBACK').catch(() => undefined)
              throw error
            } finally {
              client.release()
            }
          },
        }
      }
      if (specifier === '@/lib/pipeline/reportingSnapshot.mjs') {
        return { normalizePipelineReportingSnapshot }
      }
      if (specifier.startsWith('@/')) return emptyDependency
      return requireFromApp(specifier)
    },
  }, { filename: path })
  return module.exports
}

async function installReportingSchema(pool) {
  await pool.query(`
    CREATE TABLE pipeline_spaces (
      id uuid PRIMARY KEY,
      workspace_organization_id uuid NOT NULL
    );

    CREATE TABLE crm_contacts (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE crm_opportunities (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
      status text,
      stage text,
      priority text,
      amount numeric(18,2) NOT NULL DEFAULT 0,
      probability numeric(5,2) NOT NULL DEFAULT 0,
      expected_close date,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE crm_interactions (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE CASCADE,
      interaction_type text,
      occurred_at timestamptz,
      source_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL
    );
  `)
}

async function insertTimedRows(pool, table, pipelineId, timestamps) {
  for (const timestamp of timestamps) {
    await pool.query(
      `INSERT INTO ${table} (id, pipeline_id, created_at) VALUES ($1::uuid, $2::uuid, $3::timestamptz)`,
      [randomUUID(), pipelineId, timestamp],
    )
  }
}

async function insertInteraction(pool, input) {
  await pool.query(
    `INSERT INTO crm_interactions (
       id, pipeline_id, interaction_type, occurred_at, source_payload, created_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::jsonb, $6::timestamptz)`,
    [
      randomUUID(),
      input.pipelineId,
      input.type,
      input.occurredAt,
      JSON.stringify(input.sourcePayload || {}),
      input.createdAt || input.occurredAt,
    ],
  )
}

async function insertOpportunity(pool, input) {
  await pool.query(
    `INSERT INTO crm_opportunities (
       id, pipeline_id, status, stage, priority, amount, probability, expected_close, created_at
     ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $8::date, $9::timestamptz)`,
    [
      randomUUID(),
      input.pipelineId,
      input.status,
      input.stage,
      input.priority || null,
      input.amount,
      input.probability,
      input.expectedClose || null,
      input.createdAt,
    ],
  )
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

async function acceptance(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 })
  try {
    await installReportingSchema(pool)
    const organizationA = randomUUID()
    const organizationB = randomUUID()
    const pipelineA = randomUUID()
    const pipelineB = randomUUID()
    await pool.query(
      `INSERT INTO pipeline_spaces (id, workspace_organization_id)
       VALUES ($1::uuid, $2::uuid), ($3::uuid, $4::uuid)`,
      [pipelineA, organizationA, pipelineB, organizationB],
    )

    const startAt = '2026-06-01T04:00:00.000Z'
    const endAtExclusive = '2026-09-01T04:00:00.000Z'

    // Only the exact start and the final representable PostgreSQL microsecond belong to pipeline A.
    await insertTimedRows(pool, 'crm_contacts', pipelineA, [
      '2026-06-01T03:59:59.999999Z',
      startAt,
      '2026-09-01T03:59:59.999999Z',
      endAtExclusive,
    ])
    for (const opportunity of [
      {
        status: 'Won',
        stage: 'Closed',
        priority: 'B',
        amount: '100.00',
        probability: '100.00',
        expectedClose: '2026-08-10',
        createdAt: '2026-06-01T03:59:59.999999Z',
      },
      {
        status: 'Open',
        stage: 'Proposal',
        priority: 'A',
        amount: '100.25',
        probability: '25.00',
        expectedClose: '2026-08-15',
        createdAt: startAt,
      },
      {
        status: 'On Hold',
        stage: 'proposal',
        priority: 'a+',
        amount: '200.75',
        probability: '50.00',
        expectedClose: '2027-03-10',
        createdAt: '2026-09-01T03:59:59.999999Z',
      },
      {
        status: 'Lost',
        stage: 'Loss',
        priority: 'C',
        amount: '400.00',
        probability: '0.00',
        expectedClose: '2026-08-20',
        createdAt: endAtExclusive,
      },
    ]) {
      await insertOpportunity(pool, { pipelineId: pipelineA, ...opportunity })
    }

    const includedInteractions = [
      { type: 'Direct_Mail', occurredAt: startAt },
      // UTC July, but still June in America/New_York.
      { type: 'Linked In', occurredAt: '2026-07-01T03:30:00.000Z' },
      { type: 'Email', occurredAt: null, createdAt: '2026-08-04T14:00:00.000Z' },
      { type: 'phone-call', occurredAt: '2026-08-05T14:00:00.000Z' },
      { type: 'Meeting', occurredAt: '2026-08-06T14:00:00.000Z' },
      { type: 'Notes', occurredAt: '2026-08-07T14:00:00.000Z' },
      { type: 'Campaigns', occurredAt: '2026-08-08T14:00:00.000Z' },
      { type: 'Webinar', occurredAt: '2026-09-01T03:59:59.999999Z' },
    ]
    for (const interaction of includedInteractions) {
      await insertInteraction(pool, { pipelineId: pipelineA, ...interaction })
    }
    await insertInteraction(pool, {
      pipelineId: pipelineA,
      type: 'Email',
      occurredAt: '2026-06-01T03:59:59.999999Z',
    })
    await insertInteraction(pool, {
      pipelineId: pipelineA,
      type: 'Call',
      occurredAt: endAtExclusive,
    })
    await insertInteraction(pool, {
      pipelineId: pipelineA,
      type: 'Note',
      occurredAt: '2026-08-09T14:00:00.000Z',
      sourcePayload: { archived: true },
    })

    // A second organization's activity is deliberately noisy and must never leak into A.
    await insertTimedRows(pool, 'crm_contacts', pipelineB, [
      '2026-06-02T12:00:00.000Z',
      '2026-07-02T12:00:00.000Z',
      '2026-08-02T12:00:00.000Z',
    ])
    await insertTimedRows(pool, 'crm_opportunities', pipelineB, [
      '2026-06-03T12:00:00.000Z',
      '2026-07-03T12:00:00.000Z',
      '2026-08-03T12:00:00.000Z',
    ])
    await insertInteraction(pool, {
      pipelineId: pipelineB,
      type: 'Email',
      occurredAt: '2026-07-10T12:00:00.000Z',
    })
    await insertInteraction(pool, {
      pipelineId: pipelineB,
      type: 'Unknown second-tenant activity',
      occurredAt: '2026-07-11T12:00:00.000Z',
    })

    const persistence = loadCrmPersistence(pool)
    const reportA = plain(await persistence.readCrmPipelineActivityReportFromPostgres({
      pipelineId: pipelineA,
      organizationId: organizationA,
      startAt,
      endAtExclusive,
      timeZone: 'America/New_York',
      snapshotDate: '2026-08-28',
    }))

    assert.deepEqual(reportA, {
      contactsAdded: 2,
      interactions: 8,
      opportunitiesCreated: 2,
      interactionsByMonth: [
        {
          month: '2026-06',
          label: 'Jun 2026',
          total: 2,
          types: {
            directMail: 1,
            linkedIn: 1,
            email: 0,
            call: 0,
            inPerson: 0,
            note: 0,
            campaign: 0,
            other: 0,
          },
        },
        {
          month: '2026-07',
          label: 'Jul 2026',
          total: 0,
          types: {
            directMail: 0,
            linkedIn: 0,
            email: 0,
            call: 0,
            inPerson: 0,
            note: 0,
            campaign: 0,
            other: 0,
          },
        },
        {
          month: '2026-08',
          label: 'Aug 2026',
          total: 6,
          types: {
            directMail: 0,
            linkedIn: 0,
            email: 1,
            call: 1,
            inPerson: 1,
            note: 1,
            campaign: 1,
            other: 1,
          },
        },
      ],
      snapshot: {
        totalContacts: 4,
        totalOpportunities: 4,
        activeOpportunities: 2,
        openOpportunities: 1,
        onHoldOpportunities: 1,
        highPriorityActiveOpportunities: 2,
        wonOpportunities: 1,
        lostOpportunities: 1,
        activePipelineValue: 301,
        weightedPipelineValue: 125.4375,
        lifetimeWinRate: 50,
        opportunitiesByStage: [
          { stage: 'Closed', count: 1 },
          { stage: 'Loss', count: 1 },
          { stage: 'Proposal', count: 2 },
        ],
        activeByStage: [{
          label: 'Proposal',
          count: 2,
          value: 301,
          weighted: 125.4375,
        }],
        activeByCloseQuarter: [
          { label: 'Q3 2026', count: 1, value: 100.25, weighted: 25.0625 },
          { label: 'Q1 2027', count: 1, value: 200.75, weighted: 100.375 },
        ],
        attention: {
          total: 1,
          lifecycleConflicts: 0,
          overdue: 1,
          missingCloseDate: 0,
          invalidProbability: 0,
        },
        forecast: {
          months: [
            {
              month: '2026-08',
              potential: 100.25,
              weighted: 25.0625,
              stages: [{ stage: 'Proposal', value: 100.25 }],
            },
            { month: '2026-09', potential: 0, weighted: 0, stages: [] },
            { month: '2026-10', potential: 0, weighted: 0, stages: [] },
            { month: '2026-11', potential: 0, weighted: 0, stages: [] },
            { month: '2026-12', potential: 0, weighted: 0, stages: [] },
            { month: '2027-01', potential: 0, weighted: 0, stages: [] },
          ],
          outsideOrUnscheduledPotential: 200.75,
          outsideOrUnscheduledWeighted: 100.375,
        },
      },
    })

    for (const month of reportA.interactionsByMonth) {
      const categoryTotal = Object.values(month.types).reduce((sum, count) => sum + count, 0)
      assert.equal(categoryTotal, month.total, `${month.month} category counts must reconcile`)
    }
    assert.equal(
      reportA.interactionsByMonth.reduce((sum, month) => sum + month.total, 0),
      reportA.interactions,
      'Monthly interaction totals must reconcile with the period total',
    )

    const reportB = plain(await persistence.readCrmPipelineActivityReportFromPostgres({
      pipelineId: pipelineB,
      organizationId: organizationB,
      startAt,
      endAtExclusive,
      timeZone: 'America/New_York',
      snapshotDate: '2026-08-28',
    }))
    assert.equal(reportB.contactsAdded, 3)
    assert.equal(reportB.opportunitiesCreated, 3)
    assert.equal(reportB.interactions, 2)
    assert.equal(reportB.interactionsByMonth[1].types.email, 1)
    assert.equal(reportB.interactionsByMonth[1].types.other, 1)

    await assert.rejects(
      persistence.readCrmPipelineActivityReportFromPostgres({
        pipelineId: pipelineA,
        organizationId: organizationB,
        startAt,
        endAtExclusive,
        timeZone: 'America/New_York',
        snapshotDate: '2026-08-28',
      }),
      /Pipeline reporting scope was not found/,
      'A pipeline must not be readable through a different workspace organization',
    )
  } finally {
    await pool.end()
  }
}

const childDatabaseUrl = String(process.env.CLAWPILOT_PIPELINE_REPORTING_DATABASE_URL || '').trim()
if (childDatabaseUrl) {
  const parsed = new URL(childDatabaseUrl)
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
    'Pipeline reporting acceptance is restricted to disposable local PostgreSQL',
  )
  await acceptance(parsed.toString())
  console.log('pipeline reporting disposable Postgres checks passed')
  process.exit(0)
}

execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 })
const container = `clawpilot-pipeline-reporting-${process.pid}-${randomUUID().slice(0, 8)}`
try {
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', container,
    '-e', 'POSTGRES_PASSWORD=clawpilot_pipeline_reporting',
    '-e', 'POSTGRES_DB=clawpilot_pipeline_reporting',
    '-p', '127.0.0.1::5432',
    disposablePostgresImage,
  ], { stdio: 'ignore', timeout: 180_000 })
  const portOutput = execFileSync('docker', ['port', container, '5432/tcp'], {
    encoding: 'utf8',
  })
  const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
  assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port: ${portOutput}`)
  const databaseUrl = `postgresql://postgres:clawpilot_pipeline_reporting@127.0.0.1:${port}/clawpilot_pipeline_reporting`
  await waitForPostgres(databaseUrl)
  execFileSync('node', ['scripts/test-pipeline-reporting-postgres.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      CLAWPILOT_PIPELINE_REPORTING_DATABASE_URL: databaseUrl,
      PGSSLMODE: 'disable',
    },
    stdio: 'inherit',
    timeout: 180_000,
  })
} finally {
  spawnSync('docker', ['stop', '-t', '1', container], {
    stdio: 'ignore',
    timeout: 20_000,
  })
}
