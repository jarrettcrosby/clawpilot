#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const images = ['postgres:16-alpine', 'postgres:18-alpine']
const migrations = [
  '0329_career_site_submissions.sql',
  '0330_career_site_mail_outbox.sql',
]

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim()
}

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

async function installCareerSchema(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum text
    );
    CREATE TABLE app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE app_user_organization_memberships (
      user_email text NOT NULL,
      organization_id uuid NOT NULL,
      PRIMARY KEY (user_email, organization_id)
    );
  `)
  for (const filename of migrations) {
    const source = readFileSync(
      resolve(root, 'db/migrations', filename),
      'utf8',
    )
    const checksum = createHash('sha256').update(source).digest('hex')
    await pool.query(source)
    await pool.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [filename, checksum],
    )
  }
  await pool.end()
}

async function verifyImage(image) {
  const majorVersion = image.match(/postgres:(\d+)-alpine/u)?.[1]
  assert.ok(majorVersion, `Unexpected PostgreSQL image: ${image}`)
  const container = `clawpilot-career-catalog-${majorVersion}-${process.pid}-${randomUUID().slice(0, 8)}`
  const password = `career_catalog_${majorVersion}`
  try {
    command(
      'docker',
      [
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '-e',
        `POSTGRES_PASSWORD=${password}`,
        '-e',
        'POSTGRES_DB=career_catalog',
        '-p',
        '127.0.0.1::5432',
        image,
      ],
      { timeout: 180_000 },
    )
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/career_catalog`
    await waitForPostgres(databaseUrl)
    await installCareerSchema(databaseUrl)
    const output = command(
      process.execPath,
      ['scripts/verify-career-site-migrations.mjs', '--post-apply'],
      {
        env: {
          ...process.env,
          CAREER_SITE_MIGRATION_DATABASE_URL: databaseUrl,
        },
      },
    )
    assert.match(
      output,
      new RegExp(
        `exact PostgreSQL ${majorVersion} post-apply catalog verified`,
        'u',
      ),
    )
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
}

command('docker', ['info'], { timeout: 30_000 })
for (const image of images) await verifyImage(image)
console.log('Career-site migration verifier passed on PostgreSQL 16 and 18')
