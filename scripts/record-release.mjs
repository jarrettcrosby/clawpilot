#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(scriptDir, '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function fail(message) {
  console.error(`record-release failed: ${message}`)
  process.exit(1)
}

function firstEnvironmentValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function normalizedEnvironment(value) {
  const environment = String(value || '').trim().toLowerCase()
  if (!environment) fail('release environment is required')
  if (environment.length > 120) fail('release environment must be 120 characters or fewer')
  return environment
}

function parseList(value, label) {
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string')) fail(`${label} must contain only strings`)
    return value.map((item) => item.trim()).filter(Boolean)
  }
  const raw = String(value).trim()
  if (!raw) return []

  if (raw.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      fail(`${label} must be a JSON array or a newline-separated list`)
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      fail(`${label} must contain only strings`)
    }
    return parsed.map((item) => item.trim()).filter(Boolean)
  }

  const separator = raw.includes('\n') ? /\r?\n/ : raw.includes('||') ? /\s*\|\|\s*/ : null
  return (separator ? raw.split(separator) : [raw]).map((item) => item.trim()).filter(Boolean)
}

function catalogEntries(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value.releases)) return value.releases
  if (value.releases && typeof value.releases === 'object') {
    return Object.entries(value.releases)
      .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map(([commitHash, entry]) => ({ commitHash, ...entry }))
  }
  if (value.commit || value.commitHash || value.sha) return [value]
  return Object.entries(value)
    .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([commitHash, entry]) => ({ commitHash, ...entry }))
}

function entryCommit(entry) {
  return String(entry?.commitHash || entry?.commit_hash || entry?.commit || entry?.sha || '').trim().toLowerCase()
}

function commitMatches(candidate, commit) {
  if (candidate.length < 7) return false
  return candidate === commit || candidate.startsWith(commit) || commit.startsWith(candidate)
}

function isDefaultCatalogEntry(entry) {
  const candidate = entryCommit(entry)
  return candidate === '*' || candidate === 'default'
}

function readCatalogEntry(commit, environment) {
  const catalogPath = resolve(root, 'docs', 'releases', 'catalog.json')
  if (!existsSync(catalogPath)) return null

  let catalog
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } catch (error) {
    fail(`unable to parse docs/releases/catalog.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  const entries = catalogEntries(catalog)
  const matches = entries
    .filter((entry) => entry && typeof entry === 'object' && commitMatches(entryCommit(entry), commit))
    .filter((entry) => {
      const candidateEnvironment = String(entry.environment || entry.env || '').trim().toLowerCase()
      return !candidateEnvironment || candidateEnvironment === '*' || candidateEnvironment === environment
    })

  const matched = matches.find((entry) => String(entry.environment || entry.env || '').trim().toLowerCase() === environment)
    || matches[0]
  if (matched) return matched

  const defaults = entries
    .filter((entry) => entry && typeof entry === 'object' && isDefaultCatalogEntry(entry))
    .filter((entry) => {
      const candidateEnvironment = String(entry.environment || entry.env || '').trim().toLowerCase()
      return !candidateEnvironment || candidateEnvironment === '*' || candidateEnvironment === environment
    })
  return defaults.find((entry) => String(entry.environment || entry.env || '').trim().toLowerCase() === environment)
    || defaults[0]
    || null
}

function textValue(value, fallback, label, maxLength) {
  const text = value === undefined || value === null ? String(fallback || '').trim() : String(value).trim()
  if (label === 'title' && !text) fail('release title is required')
  if (text.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer`)
  return text
}

function optionalText(value, maxLength, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const text = String(value).trim()
  if (text.length > maxLength) fail(`${label} must be ${maxLength} characters or fewer`)
  return text
}

function deployedAtValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const date = new Date(String(value).trim())
  if (Number.isNaN(date.getTime())) fail('release deployment time must be a valid date')
  return date.toISOString()
}

function runMigrations() {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', 'db-migrate.mjs')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) fail(`unable to run migrations: ${result.error.message}`)
  if (result.status !== 0) fail(`database migrations exited with status ${result.status ?? 'unknown'}`)
}

if (!process.env.DATABASE_URL) fail('DATABASE_URL is required')

const environment = normalizedEnvironment(firstEnvironmentValue(
  'RELEASE_ENVIRONMENT',
  'CLAWPILOT_RELEASE_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_NAME',
  'VERCEL_ENV',
  'NODE_ENV',
))
const commitHash = String(firstEnvironmentValue(
  'RELEASE_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'GITHUB_SHA',
  'BUILD_COMMIT',
) || '').trim().toLowerCase()
if (commitHash.length < 7) fail('release commit must contain at least 7 characters')

const catalog = readCatalogEntry(commitHash, environment)
const envFeatures = parseList(process.env.RELEASE_FEATURES, 'RELEASE_FEATURES')
const envFixes = parseList(process.env.RELEASE_FIXES, 'RELEASE_FIXES')
const features = envFeatures ?? parseList(catalog?.features, 'catalog features') ?? []
const fixes = envFixes ?? parseList(catalog?.fixes, 'catalog fixes') ?? []
const title = textValue(process.env.RELEASE_TITLE, catalog?.title || `Release ${commitHash.slice(0, 7)}`, 'title', 240)
const summary = textValue(process.env.RELEASE_SUMMARY, catalog?.summary || '', 'summary', 5000)
const branch = optionalText(firstEnvironmentValue(
  'RELEASE_BRANCH',
  'RAILWAY_GIT_BRANCH',
  'VERCEL_GIT_COMMIT_REF',
  'GITHUB_REF_NAME',
) || catalog?.branch, 240, 'branch')
const deploymentId = optionalText(firstEnvironmentValue(
  'RELEASE_DEPLOYMENT_ID',
  'RAILWAY_DEPLOYMENT_ID',
  'VERCEL_DEPLOYMENT_ID',
) || catalog?.deploymentId || catalog?.deployment_id, 240, 'deployment ID')
const releaseKey = deploymentId ? `deployment:${deploymentId}` : `commit:${commitHash}`
const source = String(process.env.RELEASE_SOURCE || catalog?.source || 'deployment').trim().toLowerCase()
if (!['deployment', 'historical', 'manual'].includes(source)) {
  fail('release source must be deployment, historical, or manual')
}
const deployedAt = deployedAtValue(process.env.RELEASE_DEPLOYED_AT || catalog?.deployedAt || catalog?.deployed_at)
const usesOneTimeDefault = Boolean(
  catalog?.oncePerEnvironment === true
  && isDefaultCatalogEntry(catalog)
  && process.env.RELEASE_TITLE === undefined
  && process.env.RELEASE_SUMMARY === undefined
  && envFeatures === null
  && envFixes === null
)

runMigrations()

const sslMode = String(process.env.PGSSLMODE || process.env.DATABASE_SSL || '').toLowerCase()
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'require' || sslMode === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
})

async function main() {
  let effectiveTitle = title
  let effectiveSummary = summary
  let effectiveFeatures = features
  let effectiveFixes = fixes
  if (usesOneTimeDefault) {
    const prior = await pool.query(
      `
        SELECT 1
        FROM release_entries
        WHERE environment = $1
          AND commit_hash <> $2
          AND title = $3
        LIMIT 1
      `,
      [environment, commitHash, title],
    )
    if (prior.rows[0]) {
      effectiveTitle = `Release ${commitHash.slice(0, 7)}`
      effectiveSummary = `Commit ${commitHash.slice(0, 7)} passed the ClawPilot startup health contract and was released to ${environment}.`
      effectiveFeatures = []
      effectiveFixes = []
    }
  }
  const values = [
    releaseKey,
    commitHash,
    environment,
    branch,
    deploymentId,
    effectiveTitle,
    effectiveSummary,
    effectiveFeatures,
    effectiveFixes,
    source,
    deployedAt,
  ]
  const result = await pool.query(
    `
      INSERT INTO release_entries (
        release_key, commit_hash, environment, branch, deployment_id, title, summary,
        features, fixes, source, deployed_at, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10,
        COALESCE($11::timestamptz, now()), now(), now()
      )
      ON CONFLICT (environment, release_key) DO UPDATE SET
        commit_hash = EXCLUDED.commit_hash,
        branch = EXCLUDED.branch,
        deployment_id = EXCLUDED.deployment_id,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        features = EXCLUDED.features,
        fixes = EXCLUDED.fixes,
        source = EXCLUDED.source,
        deployed_at = COALESCE($11::timestamptz, release_entries.deployed_at),
        updated_at = now()
      WHERE (
        release_entries.branch,
        release_entries.deployment_id,
        release_entries.title,
        release_entries.summary,
        release_entries.features,
        release_entries.fixes,
        release_entries.source,
        release_entries.deployed_at
      ) IS DISTINCT FROM (
        EXCLUDED.branch,
        EXCLUDED.deployment_id,
        EXCLUDED.title,
        EXCLUDED.summary,
        EXCLUDED.features,
        EXCLUDED.fixes,
        EXCLUDED.source,
        COALESCE($11::timestamptz, release_entries.deployed_at)
      )
      RETURNING id, deployed_at
    `,
    values,
  )

  const row = result.rows[0] || (await pool.query(
    `
      SELECT id, deployed_at
      FROM release_entries
      WHERE environment = $1 AND release_key = $2
    `,
    [environment, releaseKey],
  )).rows[0]

  console.log(JSON.stringify({
    ok: true,
    id: row.id,
    environment,
    commit: commitHash,
    deployedAt: new Date(row.deployed_at).toISOString(),
    changed: result.rowCount > 0,
  }))
}

main()
  .catch((error) => {
    console.error(`record-release failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
  .finally(() => pool.end())
