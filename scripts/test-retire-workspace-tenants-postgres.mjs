#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APPROVED_TARGETS,
  CONFIRMED_OPERATOR_EMAIL,
  PRODUCTION_DATABASE_IDENTITY,
  PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  PRODUCTION_RAILWAY_PROJECT_ID,
  databaseEndpointFingerprint,
  run,
} from './retire-workspace-tenants.mjs'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const fixedTime = '2026-09-06T12:00:00.000Z'
const safeOrganizationId = '7fc721b4-8530-40c1-b920-a11920cd8635'
const safeOrganizationReference = 'ga000000000001'
const reviewerEmail = 'reviewer@example.test'
const generatedReferences = [
  'gex000000000001',
  'gex000000000002',
  'gex000000000003',
  'gex000000000004',
  'gex000000000005',
  'gex000000000006',
]

function command(executable, args) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch (error) {
      lastError = error
      await pool.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function targetFlags() {
  return APPROVED_TARGETS.flatMap((target) => [
    '--target', `${target.organizationId}|${target.referenceCode}|${target.name}`,
  ])
}

function commonFlags() {
  return [
    '--actor', CONFIRMED_OPERATOR_EMAIL,
    '--environment', 'production',
    '--railway-project-id', PRODUCTION_RAILWAY_PROJECT_ID,
    '--railway-environment-id', PRODUCTION_RAILWAY_ENVIRONMENT_ID,
    ...targetFlags(),
  ]
}

async function installFixture(client) {
  await client.query(`
    CREATE TABLE app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    );
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE global_reference_entity_types (
      prefix text PRIMARY KEY,
      entity_type text NOT NULL
    );
    CREATE TABLE crm_reference_number_registry (
      number_value text PRIMARY KEY,
      allocated_at timestamptz NOT NULL
    );
    CREATE TABLE crm_reference_registry (
      reference_code text PRIMARY KEY,
      prefix text NOT NULL,
      canonical_code text NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'alias', 'retired')),
      allocated_at timestamptz NOT NULL,
      retired_at timestamptz,
      FOREIGN KEY (canonical_code) REFERENCES crm_reference_registry(reference_code)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE workspace_organizations (
      id uuid PRIMARY KEY,
      parent_id uuid REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      name text NOT NULL,
      organization_type text NOT NULL,
      reference_code text NOT NULL UNIQUE REFERENCES crm_reference_registry(reference_code),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE app_users (
      email text PRIMARY KEY,
      display_name text NOT NULL,
      role text NOT NULL,
      status text NOT NULL,
      organization_id uuid REFERENCES workspace_organizations(id) ON DELETE SET NULL,
      organization_name text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE app_user_organization_memberships (
      user_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      role text NOT NULL,
      status text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (user_email, organization_id)
    );
    CREATE TABLE pipeline_spaces (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      workspace_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE project_boards (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      workspace_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE tenant_assets (
      id uuid PRIMARY KEY,
      global_id text NOT NULL UNIQUE REFERENCES crm_reference_registry(reference_code),
      organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      label text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE tenant_asset_events (
      id uuid PRIMARY KEY,
      asset_id uuid NOT NULL REFERENCES tenant_assets(id) ON DELETE RESTRICT,
      description text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE crm_organizations (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
      reference_code text NOT NULL REFERENCES crm_reference_registry(reference_code),
      suitecrm_id text,
      name text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE sync_outbox (
      id uuid PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE short_links (
      id uuid PRIMARY KEY,
      owner_email text NOT NULL,
      slug text NOT NULL UNIQUE,
      organization_root_id uuid REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      disabled_at timestamptz,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE short_link_clicks (
      id bigserial PRIMARY KEY,
      short_link_id uuid NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
      clicked_at timestamptz NOT NULL
    );
    CREATE TABLE audit_events (
      id bigserial PRIMARY KEY,
      actor text NOT NULL,
      event_type text NOT NULL,
      event_key text NOT NULL UNIQUE,
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      subject text NOT NULL,
      organization_id uuid,
      is_system boolean NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );

    CREATE FUNCTION fixture_reject_asset_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fixture asset delete guard';
    END;
    $$;
    CREATE TRIGGER fixture_reject_asset_delete
      BEFORE DELETE ON tenant_assets
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_asset_delete();
  `)

  const receiptMigration = readFileSync(
    new URL('../db/migrations/0360_workspace_tenant_retirement_receipts.sql', import.meta.url),
    'utf8',
  )
  await client.query(receiptMigration)
  await client.query(
    `INSERT INTO schema_migrations (filename) VALUES
       ('0360_workspace_tenant_retirement_receipts.sql')`,
  )
  await client.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('deployment.database.identity', jsonb_build_object('id', $1::text))`,
    [PRODUCTION_DATABASE_IDENTITY],
  )
  await client.query(
    `INSERT INTO global_reference_entity_types (prefix, entity_type)
     VALUES ('ga', 'organization'), ('gex', 'fixture')`,
  )

  const allCanonicalReferences = [
    safeOrganizationReference,
    ...APPROVED_TARGETS.map((target) => target.referenceCode),
    ...generatedReferences,
  ]
  for (const reference of allCanonicalReferences) {
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, allocated_at
       ) VALUES ($1, $2, $1, 'active', $3)`,
      [reference, reference.startsWith('gex') ? 'gex' : 'ga', fixedTime],
    )
  }
  const aliasReference = 'gex000000000007'
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at, retired_at
     ) VALUES ($1, 'gex', $2, 'alias', $3, $3)`,
    [aliasReference, generatedReferences[0], fixedTime],
  )

  await client.query(
    `INSERT INTO workspace_organizations (
       id, parent_id, name, organization_type, reference_code, created_at, updated_at
     ) VALUES ($1, NULL, 'Safe retained workspace', 'member', $2, $3, $3)`,
    [safeOrganizationId, safeOrganizationReference, fixedTime],
  )
  for (const target of APPROVED_TARGETS) {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, parent_id, name, organization_type, reference_code, created_at, updated_at
       ) VALUES ($1, NULL, $2, 'member', $3, $4, $4)`,
      [target.organizationId, target.name, target.referenceCode, fixedTime],
    )
  }

  await client.query(
    `INSERT INTO app_users (
       email, display_name, role, status, organization_id, organization_name,
       created_at, updated_at
     ) VALUES
       ($1, 'Retirement operator', 'owner', 'active', $2, 'Safe retained workspace', $3, $3),
       ($4, 'Reviewer', 'member', 'active', $5, $6, $3, $3)`,
    [
      CONFIRMED_OPERATOR_EMAIL,
      safeOrganizationId,
      fixedTime,
      reviewerEmail,
      APPROVED_TARGETS[0].organizationId,
      APPROVED_TARGETS[0].name,
    ],
  )
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default, updated_at
     ) VALUES ($1, $2, 'owner', 'active', true, $4),
              ($3, $2, 'member', 'active', false, $4)`,
    [CONFIRMED_OPERATOR_EMAIL, safeOrganizationId, reviewerEmail, fixedTime],
  )

  for (const [index, target] of APPROVED_TARGETS.entries()) {
    const pipelineId = randomUUID()
    const boardId = randomUUID()
    const assetId = randomUUID()
    const eventId = randomUUID()
    const crmId = randomUUID()
    const linkId = randomUUID()
    const assetReference = generatedReferences[index * 2]
    const crmReference = generatedReferences[index * 2 + 1]
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default, updated_at
       ) VALUES ($1, $2, 'owner', 'active', false, $3)`,
      [CONFIRMED_OPERATOR_EMAIL, target.organizationId, fixedTime],
    )
    if (index === 0) {
      await client.query(
        `INSERT INTO app_user_organization_memberships (
           user_email, organization_id, role, status, is_default, updated_at
         ) VALUES ($1, $2, 'member', 'active', true, $3)`,
        [reviewerEmail, target.organizationId, fixedTime],
      )
    }
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, workspace_organization_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4)`,
      [pipelineId, `${target.name} pipeline`, target.organizationId, fixedTime],
    )
    await client.query(
      `INSERT INTO project_boards (
         id, name, workspace_organization_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4)`,
      [boardId, `${target.name} board`, target.organizationId, fixedTime],
    )
    await client.query(
      `INSERT INTO tenant_assets (
         id, global_id, organization_id, label, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [assetId, assetReference, target.organizationId, `${target.name} asset`, fixedTime],
    )
    await client.query(
      `INSERT INTO tenant_asset_events (
         id, asset_id, description, created_at
       ) VALUES ($1, $2, 'FK-only transitive child', $3)`,
      [eventId, assetId, fixedTime],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, reference_code, suitecrm_id, name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [crmId, pipelineId, crmReference, `suitecrm-${index + 1}`, target.name, fixedTime],
    )
    await client.query(
      `INSERT INTO sync_outbox (
         id, aggregate_type, aggregate_id, payload, created_at
       ) VALUES ($1, 'tenant_asset', $2, '{}'::jsonb, $3)`,
      [randomUUID(), assetId, fixedTime],
    )
    await client.query(
      `INSERT INTO short_links (
         id, owner_email, slug, organization_root_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [
        linkId,
        CONFIRMED_OPERATOR_EMAIL,
        index === 0 ? aliasReference : `retirement-link-${index}`,
        target.organizationId,
        fixedTime,
      ],
    )
    await client.query(
      `INSERT INTO short_link_clicks (short_link_id, clicked_at)
       VALUES ($1, $2)`,
      [linkId, fixedTime],
    )
    await client.query(
      `INSERT INTO audit_events (
         actor, event_type, event_key, aggregate_type, aggregate_id,
         subject, organization_id, is_system, payload, created_at
       ) VALUES ('fixture', 'fixture.created', $1, 'workspace', $2,
         $3, $4, false, '{}'::jsonb, $5)`,
      [`fixture-audit-${index}`, target.organizationId, target.name, target.organizationId, fixedTime],
    )
  }

  const safeAssetId = 'e712f85b-4c2f-4e4f-8e76-ea19e011e070'
  const safeAssetReference = 'gex000000000008'
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at
     ) VALUES ($1, 'gex', $1, 'active', $2)`,
    [safeAssetReference, fixedTime],
  )
  await client.query(
    `INSERT INTO tenant_assets (id, global_id, organization_id, label, created_at)
     VALUES ($1, $2, $3, 'Safe retained asset', $4)`,
    [safeAssetId, safeAssetReference, safeOrganizationId, fixedTime],
  )
  return { aliasReference, safeAssetId, safeAssetReference }
}

let containerName = null
let pool = null
const artifacts = mkdtempSync(join(tmpdir(), 'clawpilot-tenant-retirement-test-'))
chmodSync(artifacts, 0o700)

try {
  const suppliedUrl = process.env.CLAWPILOT_TENANT_RETIRE_TEST_POSTGRES_URL
  let databaseUrl
  if (suppliedUrl) {
    const parsed = new URL(suppliedUrl)
    assert.ok(
      ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
      'Acceptance test refuses non-loopback PostgreSQL',
    )
    databaseUrl = suppliedUrl
  } else {
    containerName = `clawpilot-tenant-retirement-${process.pid}-${randomUUID().slice(0, 8)}`
    command('docker', [
      'run', '--rm', '--detach',
      '--name', containerName,
      '--env', 'POSTGRES_PASSWORD=tenant_retirement_test',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine',
    ])
    const binding = command('docker', ['port', containerName, '5432/tcp'])
    const port = /:(\d+)$/u.exec(binding)?.[1]
    assert.ok(port, `Could not parse disposable PostgreSQL port: ${binding}`)
    databaseUrl = `postgresql://postgres:tenant_retirement_test@127.0.0.1:${port}/postgres`
  }

  await waitForPostgres(databaseUrl)
  pool = new Pool({ connectionString: databaseUrl, max: 3 })
  const client = await pool.connect()
  let fixture
  try {
    fixture = await installFixture(client)
  } finally {
    client.release()
  }

  const environment = {
    DATABASE_URL: databaseUrl,
    PGSSLMODE: 'disable',
    RAILWAY_PROJECT_ID: PRODUCTION_RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: PRODUCTION_RAILWAY_ENVIRONMENT_ID,
    RAILWAY_ENVIRONMENT_NAME: 'production',
    CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256:
      databaseEndpointFingerprint(databaseUrl),
  }
  const planPath = join(artifacts, 'reviewed-plan.json')
  const receiptPath = join(artifacts, 'receipt.json')
  const before = await pool.query('SELECT count(*)::integer AS count FROM workspace_organizations')
  const planResult = await run([
    ...commonFlags(), '--output', planPath,
  ], environment, { pool })
  assert.equal(planResult.command, 'plan')
  assert.equal(planResult.applyReady, true)
  assert.equal(planResult.suiteCrmRecordsRetainedExternally, 3)
  const afterPlan = await pool.query('SELECT count(*)::integer AS count FROM workspace_organizations')
  assert.equal(afterPlan.rows[0].count, before.rows[0].count, 'Plan must be read-only')

  const manifest = JSON.parse(readFileSync(planPath, 'utf8'))
  assert.equal(manifest.scope.counts.workspace_organizations, 3)
  assert.equal(manifest.scope.counts.tenant_asset_events, 3)
  assert.equal(manifest.scope.counts.sync_outbox, 3)
  assert.equal(manifest.scope.disabledDeleteTriggers.length, 1)
  assert.equal(manifest.scope.shortLinks.length, 3)
  assert.equal(manifest.scope.blockers.relationCycles.length, 0)
  assert.equal(manifest.scope.blockers.preservedRestricts.length, 0)
  assert.equal(manifest.scope.blockers.crossTenantRows.length, 0)

  const applyBase = [
    'apply', ...commonFlags(),
    '--manifest', planPath,
    '--confirm-digest', manifest.manifestDigest,
    '--receipt-output', receiptPath,
  ]
  await assert.rejects(
    () => run(applyBase, environment, { pool }),
    /SuiteCRM is not called/u,
  )
  const afterRejectedApply = await pool.query(
    'SELECT count(*)::integer AS count FROM workspace_organizations',
  )
  assert.equal(afterRejectedApply.rows[0].count, before.rows[0].count)

  const applied = await run([
    ...applyBase,
    '--acknowledge-suitecrm-retained', manifest.scope.suiteCrmDigest,
  ], environment, { pool })
  assert.equal(applied.command, 'apply')
  assert.equal(applied.verification.organizationsRemaining, 0)
  assert.equal(applied.verification.applicationUsersRemaining, 0)
  assert.equal(applied.verification.uuidOccurrences.length, 0)
  assert.equal(applied.verification.referenceOccurrences.length, 0)
  assert.equal(applied.verification.shortLinks.clicksRemaining, 0)

  const verified = await run([
    'verify', ...commonFlags(),
    '--manifest', planPath,
    '--confirm-digest', manifest.manifestDigest,
  ], environment, { pool })
  assert.equal(verified.ok, true)
  assert.equal(verified.suiteCrmRecordsRetainedExternally, 3)

  const targetIds = APPROVED_TARGETS.map((target) => target.organizationId)
  const remainingTargets = await pool.query(
    'SELECT count(*)::integer AS count FROM workspace_organizations WHERE id = ANY($1::uuid[])',
    [targetIds],
  )
  assert.equal(remainingTargets.rows[0].count, 0)
  for (const table of [
    'pipeline_spaces',
    'project_boards',
    'tenant_asset_events',
    'crm_organizations',
    'sync_outbox',
  ]) {
    const count = await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)
    assert.equal(count.rows[0].count, 0, `${table} target scope should be absent`)
  }
  const assets = await pool.query('SELECT id::text FROM tenant_assets ORDER BY id')
  assert.deepEqual(assets.rows.map((row) => row.id), [fixture.safeAssetId])
  const reviewer = await pool.query(
    `SELECT organization_id::text, organization_name
     FROM app_users WHERE email = $1`,
    [reviewerEmail],
  )
  assert.equal(reviewer.rows[0].organization_id, safeOrganizationId)
  assert.equal(reviewer.rows[0].organization_name, 'Safe retained workspace')
  const targetMemberships = await pool.query(
    `SELECT count(*)::integer AS count
     FROM app_user_organization_memberships
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  assert.equal(targetMemberships.rows[0].count, 0)
  const retiredReferences = await pool.query(
    `SELECT reference_code, status, retired_at
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])
     ORDER BY reference_code`,
    [manifest.scope.references],
  )
  assert.equal(retiredReferences.rows.length, manifest.scope.references.length)
  assert.ok(retiredReferences.rows.every((row) => row.status === 'retired' && row.retired_at))
  assert.ok(retiredReferences.rows.some((row) => row.reference_code === fixture.aliasReference))
  const linkState = await pool.query(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (
              WHERE disabled_at IS NOT NULL AND deleted_at IS NOT NULL
                AND organization_root_id IS NULL
            )::integer AS retired
     FROM short_links
     WHERE id = ANY($1::uuid[])`,
    [manifest.scope.shortLinks.map((link) => link.id)],
  )
  assert.deepEqual(linkState.rows[0], { total: 3, retired: 3 })
  const historicalAudits = await pool.query(
    `SELECT count(*)::integer AS count FROM audit_events
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  assert.equal(historicalAudits.rows[0].count, 3, 'Historical audit evidence is preserved')
  const receipt = await pool.query(
    'SELECT id::text, retired_short_links FROM workspace_tenant_retirement_receipts',
  )
  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0].retired_short_links.length, 3)
  await assert.rejects(
    () => pool.query(
      `UPDATE workspace_tenant_retirement_receipts
       SET actor_email = 'changed@example.test' WHERE id = $1`,
      [receipt.rows[0].id],
    ),
    /immutable/u,
  )
  await assert.rejects(
    () => pool.query('DELETE FROM tenant_assets WHERE id = $1', [fixture.safeAssetId]),
    /fixture asset delete guard/u,
  )

  process.stdout.write('tenant retirement disposable PostgreSQL acceptance test passed\n')
} finally {
  if (pool) await pool.end().catch(() => undefined)
  rmSync(artifacts, { recursive: true, force: true })
  if (containerName) {
    try {
      command('docker', ['stop', '--time', '1', containerName])
    } catch {
      // The disposable container may already have exited; --rm owns cleanup.
    }
  }
}
