#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  EXPECTED_SELECTED_SCOPE_COUNTS,
  EXPECTED_SPECIAL_SCOPE_COUNTS,
  PRESERVED_SHARED_REFERENCE_CODES,
  PRODUCTION_DATABASE_IDENTITY,
  PRODUCTION_RAILWAY_ENVIRONMENT_ID,
  PRODUCTION_RAILWAY_PROJECT_ID,
  PRODUCTION_RAILWAY_SERVICE_ID,
  PROTECTED_LEGACY_CRM_ORGANIZATIONS,
  PROTECTED_SHARED_PIPELINE,
  databaseEndpointFingerprint,
  run,
} from './retire-workspace-tenants.mjs'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const fixedTime = '2026-09-06T12:00:00.000Z'
const safeOrganizationId = PROTECTED_SHARED_PIPELINE.workspaceOrganizationId
const safeOrganizationReference = 'ga000000000001'
const retainedOrganizations = [
  [safeOrganizationId, safeOrganizationReference, 'Safe retained workspace'],
  ['7fc721b4-8530-40c1-b920-a11920cd8635', 'ga000000000002', 'Retained workspace two'],
  ['12cd804d-2e32-4cff-97a2-765c20caafbf', 'ga000000000003', 'Retained workspace three'],
  ['2497181c-670b-4234-98bd-8399cd403ebc', 'ga000000000004', 'Retained workspace four'],
]
const reviewerEmail = 'reviewer@example.test'
const generatedReferences = [
  'gex000000000001',
  'gex000000000002',
  'gex000000000003',
  'gex000000000004',
  'gex000000000005',
  'gex000000000006',
]
const validatedBackupSha256 = 'd'.repeat(64)
const validatedBackupBytes = '29360128'
const productionShapedAuditCountByTarget = Object.freeze({
  'ag-alchemy': 12,
  'french-florist': 8,
  'test-pro-bakery-bites': 11,
})

assert.equal(
  Object.values(productionShapedAuditCountByTarget)
    .reduce((total, count) => total + count, 0),
  EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents,
)

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
    '--railway-service-id', PRODUCTION_RAILWAY_SERVICE_ID,
    '--validated-backup-sha256', validatedBackupSha256,
    '--validated-backup-bytes', validatedBackupBytes,
    ...targetFlags(),
  ]
}

async function installFixture(client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL
    );
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
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
      contact_reference_code text REFERENCES crm_reference_registry(reference_code),
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
    CREATE UNIQUE INDEX idx_app_user_organization_memberships_default
      ON app_user_organization_memberships (user_email)
      WHERE is_default;
    CREATE TABLE user_maton_credentials (
      id uuid PRIMARY KEY,
      owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE
    );
    CREATE TABLE user_maton_connections (
      id uuid PRIMARY KEY,
      owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE
    );
    CREATE TABLE crm_integration_cursors (
      id uuid PRIMARY KEY,
      owner_email text NOT NULL REFERENCES app_users(email) ON DELETE CASCADE
    );
    CREATE TABLE pipeline_spaces (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      workspace_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      crm_provider text NOT NULL,
      sync_enabled boolean NOT NULL,
      provisioning_status text NOT NULL,
      sheet_id text,
      drive_folder_id text,
      provisioning_sheet_id text,
      google_service_account_email text,
      google_shared_drive_id text,
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
    CREATE TABLE app_documents (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      title text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE app_sessions (
      id uuid PRIMARY KEY,
      active_workspace_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL
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
    CREATE TABLE tenant_delegations (
      id uuid PRIMARY KEY,
      platform_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT,
      account_owner_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT
    );
    CREATE TABLE empty_tenant_relation (
      id uuid PRIMARY KEY,
      executing_organization_id uuid NOT NULL
        REFERENCES workspace_organizations(id) ON DELETE RESTRICT
    );
    CREATE TABLE crm_organizations (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
      reference_code text NOT NULL REFERENCES crm_reference_registry(reference_code),
      suitecrm_id text,
      name text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE crm_contacts (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT,
      organization_id uuid NOT NULL REFERENCES crm_organizations(id) ON DELETE RESTRICT,
      reference_code text REFERENCES crm_reference_registry(reference_code),
      suitecrm_id text,
      full_name text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE crm_interactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES crm_organizations(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE crm_opportunities (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES crm_organizations(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE crm_contact_source_aliases (
      id uuid PRIMARY KEY,
      contact_id uuid NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
      source_key text NOT NULL
    );
    CREATE TABLE crm_board_projections (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT
    );
    CREATE TABLE crm_board_cards (
      id uuid PRIMARY KEY,
      projection_id uuid NOT NULL REFERENCES crm_board_projections(id) ON DELETE RESTRICT
    );
    CREATE TABLE operations_activation_scopes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES workspace_organizations(id) ON DELETE RESTRICT
    );
    CREATE TABLE pipeline_dropdown_catalogs (
      id uuid PRIMARY KEY,
      pipeline_id uuid NOT NULL REFERENCES pipeline_spaces(id) ON DELETE RESTRICT
    );
    CREATE TABLE sync_outbox (
      id uuid PRIMARY KEY,
      aggregate_type text NOT NULL,
      aggregate_id text NOT NULL,
      operation text NOT NULL,
      target_system text NOT NULL,
      status text NOT NULL,
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

    CREATE FUNCTION fixture_reject_document_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fixture document delete guard';
    END;
    $$;
    CREATE TRIGGER fixture_reject_document_delete
      BEFORE DELETE ON app_documents
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_document_delete();

    CREATE FUNCTION fixture_reject_short_link_click_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fixture short-link click delete guard';
    END;
    $$;
    CREATE TRIGGER fixture_reject_short_link_click_delete
      BEFORE DELETE ON short_link_clicks
      FOR EACH ROW EXECUTE FUNCTION fixture_reject_short_link_click_delete();
  `)

  const receiptMigration = readFileSync(
    new URL('../db/migrations/0360_workspace_tenant_retirement_receipts.sql', import.meta.url),
    'utf8',
  )
  const receiptMigrationChecksum = createHash('sha256')
    .update(receiptMigration)
    .digest('hex')
  await client.query(receiptMigration)
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
    ['0360_workspace_tenant_retirement_receipts.sql', receiptMigrationChecksum],
  )
  const receiptBoundaryMigration = readFileSync(
    new URL(
      '../db/migrations/0362_workspace_tenant_retirement_receipt_boundary_evidence.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const receiptBoundaryMigrationChecksum = createHash('sha256')
    .update(receiptBoundaryMigration)
    .digest('hex')
  await client.query('BEGIN')
  try {
    await client.query(
      `INSERT INTO workspace_tenant_retirement_receipts (
         plan_digest, receipt_digest, script_version, environment,
         railway_project_id, railway_environment_id, database_identity,
         database_endpoint_sha256, actor_email, target_organizations,
         lock_catalog_digest, locked_relations, scope_digest, scope_counts,
         retired_references, disabled_delete_triggers, retired_short_links,
         suitecrm_records, external_system_disposition, deleted_counts, verification
       ) VALUES (
         $1, $2, 'legacy-test-receipt', 'production', $3::uuid, $4::uuid, $5::uuid,
         $6, 'operator@example.test', '[{}]'::jsonb, $7, '["fixture"]'::jsonb,
         $8, '{}'::jsonb, '{}'::text[], '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
       )`,
      [
        '1'.repeat(64),
        '2'.repeat(64),
        PRODUCTION_RAILWAY_PROJECT_ID,
        PRODUCTION_RAILWAY_ENVIRONMENT_ID,
        PRODUCTION_DATABASE_IDENTITY,
        '3'.repeat(64),
        '4'.repeat(64),
        '5'.repeat(64),
      ],
    )
    await assert.rejects(
      () => client.query(receiptBoundaryMigration),
      /Cannot add tenant retirement boundary evidence after receipts exist/u,
    )
  } finally {
    await client.query('ROLLBACK')
  }
  await client.query(receiptBoundaryMigration)
  await client.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
    [
      '0362_workspace_tenant_retirement_receipt_boundary_evidence.sql',
      receiptBoundaryMigrationChecksum,
    ],
  )
  await client.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('deployment.database.identity', jsonb_build_object('id', $1::text))`,
    [PRODUCTION_DATABASE_IDENTITY],
  )
  await client.query(
    `INSERT INTO global_reference_entity_types (prefix, entity_type)
     VALUES ('ga', 'organization'), ('gc', 'contact'), ('gex', 'fixture')`,
  )

  const allCanonicalReferences = [
    ...retainedOrganizations.map(([, referenceCode]) => referenceCode),
    ...APPROVED_TARGETS.map((target) => target.referenceCode),
    ...PRESERVED_SHARED_REFERENCE_CODES,
    ...generatedReferences,
  ]
  for (const reference of allCanonicalReferences) {
    await client.query(
      `INSERT INTO crm_reference_registry (
         reference_code, prefix, canonical_code, status, allocated_at
       ) VALUES ($1, $2, $1, 'active', $3)`,
      [
        reference,
        reference.startsWith('gex') ? 'gex' : reference.startsWith('gc') ? 'gc' : 'ga',
        fixedTime,
      ],
    )
  }
  const aliasReference = 'gex000000000007'
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at, retired_at
     ) VALUES ($1, 'gex', $2, 'alias', $3, $3)`,
    [aliasReference, generatedReferences[0], fixedTime],
  )

  for (const [organizationId, referenceCode, name] of retainedOrganizations) {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, parent_id, name, organization_type, reference_code, created_at, updated_at
       ) VALUES ($1, NULL, $2, 'root', $3, $4, $4)`,
      [organizationId, name, referenceCode, fixedTime],
    )
  }
  for (const target of APPROVED_TARGETS) {
    await client.query(
      `INSERT INTO workspace_organizations (
         id, parent_id, name, organization_type, reference_code, created_at, updated_at
       ) VALUES ($1, NULL, $2, 'root', $3, $4, $4)`,
      [target.organizationId, target.name, target.referenceCode, fixedTime],
    )
  }

  await client.query(
    `INSERT INTO app_users (
       email, display_name, role, status, organization_id, organization_name,
       contact_reference_code, created_at, updated_at
     ) VALUES
       ($1, 'Retirement operator', 'owner', 'active', $2, $3, $4, $5, $5),
       ($6, 'Reviewer', 'member', 'active', $7, 'Safe retained workspace', NULL, $5, $5)`,
    [
      CONFIRMED_OPERATOR_EMAIL,
      APPROVED_TARGETS[0].organizationId,
      APPROVED_TARGETS[0].name,
      PRESERVED_SHARED_REFERENCE_CODES[0],
      fixedTime,
      reviewerEmail,
      safeOrganizationId,
    ],
  )
  for (const [organizationId] of retainedOrganizations) {
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default, updated_at
       ) VALUES ($1, $2, 'owner', 'active', $3, $4)`,
      [CONFIRMED_OPERATOR_EMAIL, organizationId, false, fixedTime],
    )
  }
  await client.query(
     `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default, updated_at
     ) VALUES ($1, $2, 'member', 'active', true, $3)`,
    [reviewerEmail, safeOrganizationId, fixedTime],
  )
  await client.query(
    `INSERT INTO user_maton_credentials (id, owner_email) VALUES ($1, $2)`,
    [randomUUID(), CONFIRMED_OPERATOR_EMAIL],
  )
  for (let index = 0; index < 17; index += 1) {
    await client.query(
      `INSERT INTO user_maton_connections (id, owner_email) VALUES ($1, $2)`,
      [randomUUID(), CONFIRMED_OPERATOR_EMAIL],
    )
  }
  for (let index = 0; index < 5; index += 1) {
    await client.query(
      `INSERT INTO crm_integration_cursors (id, owner_email) VALUES ($1, $2)`,
      [randomUUID(), CONFIRMED_OPERATOR_EMAIL],
    )
  }

  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, workspace_organization_id, crm_provider, sync_enabled,
       provisioning_status, sheet_id, drive_folder_id, provisioning_sheet_id,
       google_service_account_email, google_shared_drive_id, created_at, updated_at
     ) VALUES ($1, 'Protected shared CRM pipeline', $2, 'suitecrm', false,
       'ready', NULL, NULL, NULL, NULL, NULL, $3, $3)`,
    [PROTECTED_SHARED_PIPELINE.pipelineId, safeOrganizationId, fixedTime],
  )
  for (const [legacyIndex, legacy] of PROTECTED_LEGACY_CRM_ORGANIZATIONS.entries()) {
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, reference_code, suitecrm_id, name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        legacy.crmOrganizationId,
        legacy.pipelineId,
        generatedReferences[legacyIndex],
        legacy.suiteCrmAccountId,
        `Protected legacy customer ${legacyIndex + 1}`,
        fixedTime,
      ],
    )
    for (let index = 0; index < legacy.contactCount; index += 1) {
      await client.query(
        `INSERT INTO crm_contacts (
           id, pipeline_id, organization_id, reference_code, suitecrm_id,
           full_name, created_at
         ) VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
        [randomUUID(), legacy.pipelineId, legacy.crmOrganizationId, `Legacy contact ${index}`, fixedTime],
      )
    }
    for (let index = 0; index < legacy.interactionCount; index += 1) {
      await client.query(
        `INSERT INTO crm_interactions (id, organization_id, created_at)
         VALUES ($1, $2, $3)`,
        [randomUUID(), legacy.crmOrganizationId, fixedTime],
      )
    }
    for (let index = 0; index < legacy.opportunityCount; index += 1) {
      await client.query(
        `INSERT INTO crm_opportunities (id, organization_id, created_at)
         VALUES ($1, $2, $3)`,
        [randomUUID(), legacy.crmOrganizationId, fixedTime],
      )
    }
  }

  for (const [index, target] of APPROVED_TARGETS.entries()) {
    await client.query(
      `INSERT INTO app_user_organization_memberships (
         user_email, organization_id, role, status, is_default, updated_at
       ) VALUES ($1, $2, 'owner', 'active', $3, $4)`,
      [CONFIRMED_OPERATOR_EMAIL, target.organizationId, index === 0, fixedTime],
    )
    await client.query(
      `INSERT INTO pipeline_spaces (
         id, name, workspace_organization_id, crm_provider, sync_enabled,
         provisioning_status, sheet_id, drive_folder_id, provisioning_sheet_id,
         google_service_account_email, google_shared_drive_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'suitecrm', false, 'not_requested',
         NULL, NULL, NULL, NULL, NULL, $4, $4)`,
      [target.pipelineId, `${target.name} pipeline`, target.organizationId, fixedTime],
    )
    for (let boardIndex = 0; boardIndex < 2; boardIndex += 1) {
      await client.query(
        `INSERT INTO project_boards (
           id, name, workspace_organization_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $4)`,
        [randomUUID(), `${target.name} board ${boardIndex}`, target.organizationId, fixedTime],
      )
    }
    for (let documentIndex = 0; documentIndex < 39; documentIndex += 1) {
      await client.query(
        `INSERT INTO app_documents (id, organization_id, title, created_at)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), target.organizationId, `${target.name} document ${documentIndex}`, fixedTime],
      )
    }
    await client.query(
      `INSERT INTO app_sessions (id, active_workspace_organization_id, created_at)
       VALUES ($1, $2, $3)`,
      [randomUUID(), target.organizationId, fixedTime],
    )
    await client.query(
      `INSERT INTO crm_organizations (
         id, pipeline_id, reference_code, suitecrm_id, name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        target.crmOrganizationId,
        target.pipelineId,
        target.referenceCode,
        target.suiteCrmAccountId,
        target.name,
        fixedTime,
      ],
    )
    await client.query(
      `INSERT INTO crm_contacts (
         id, pipeline_id, organization_id, reference_code, suitecrm_id,
         full_name, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        target.crmContactId,
        target.pipelineId,
        target.crmOrganizationId,
        target.crmContactReferenceCode,
        target.suiteCrmContactId,
        `${target.name} shared provider contact`,
        fixedTime,
      ],
    )
    for (let aliasIndex = 0; aliasIndex < 2; aliasIndex += 1) {
      await client.query(
        `INSERT INTO crm_contact_source_aliases (id, contact_id, source_key)
         VALUES ($1, $2, $3)`,
        [randomUUID(), target.crmContactId, `source-${index}-${aliasIndex}`],
      )
    }
    const projectionId = randomUUID()
    await client.query(
      `INSERT INTO crm_board_projections (id, pipeline_id) VALUES ($1, $2)`,
      [projectionId, target.pipelineId],
    )
    for (let cardIndex = 0; cardIndex < 2; cardIndex += 1) {
      await client.query(
        `INSERT INTO crm_board_cards (id, projection_id) VALUES ($1, $2)`,
        [randomUUID(), projectionId],
      )
    }
    await client.query(
      `INSERT INTO pipeline_dropdown_catalogs (id, pipeline_id) VALUES ($1, $2)`,
      [randomUUID(), target.pipelineId],
    )
    if (index < 2) {
      await client.query(
        `INSERT INTO operations_activation_scopes (id, organization_id) VALUES ($1, $2)`,
        [randomUUID(), target.organizationId],
      )
    }
    await client.query(
      `INSERT INTO sync_outbox (
         id, aggregate_type, aggregate_id, operation, target_system, status,
         payload, created_at
       ) VALUES ($1, 'crm_organizations', $2, 'upsert_record', 'suitecrm',
         'succeeded', '{}'::jsonb, $3)`,
      [randomUUID(), target.crmOrganizationId, fixedTime],
    )
    const linkCount = index < 2 ? 2 : 1
    for (let linkIndex = 0; linkIndex < linkCount; linkIndex += 1) {
      const linkId = randomUUID()
      await client.query(
        `INSERT INTO short_links (
           id, owner_email, slug, organization_root_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $5)`,
        [
          linkId,
          CONFIRMED_OPERATOR_EMAIL,
          `retirement-link-${index}-${linkIndex}`,
          target.organizationId,
          fixedTime,
        ],
      )
      await client.query(
        `INSERT INTO short_link_clicks (short_link_id, clicked_at)
         VALUES ($1, $2)`,
        [linkId, fixedTime],
      )
    }
    const auditCount = productionShapedAuditCountByTarget[target.key]
    assert.ok(Number.isInteger(auditCount), `Missing audit count for ${target.key}`)
    for (let auditIndex = 0; auditIndex < auditCount; auditIndex += 1) {
      await client.query(
        `INSERT INTO audit_events (
           actor, event_type, event_key, aggregate_type, aggregate_id,
           subject, organization_id, is_system, payload, created_at
         ) VALUES ('fixture', 'fixture.created', $1, 'workspace', $2,
           $3, $4, false, '{}'::jsonb, $5)`,
        [
          `fixture-audit-${index}-${auditIndex}`,
          target.organizationId,
          target.name,
          target.organizationId,
          fixedTime,
        ],
      )
    }
  }

  const safeDocumentId = '00a4526a-d7bd-4e8a-8f57-357d0947a2e8'
  await client.query(
    `INSERT INTO app_documents (id, organization_id, title, created_at)
     VALUES ($1, $2, 'Safe retained document', $3)`,
    [safeDocumentId, safeOrganizationId, fixedTime],
  )
  const safeShortLinkId = '7e385c92-7cf2-47cf-8030-963f92926f8a'
  await client.query(
    `INSERT INTO short_links (
       id, owner_email, slug, organization_root_id, created_at, updated_at
     ) VALUES ($1, $2, 'safe-retained-link', $3, $4, $4)`,
    [safeShortLinkId, CONFIRMED_OPERATOR_EMAIL, safeOrganizationId, fixedTime],
  )
  const safeShortLinkClick = await client.query(
    `INSERT INTO short_link_clicks (short_link_id, clicked_at)
     VALUES ($1, $2) RETURNING id`,
    [safeShortLinkId, fixedTime],
  )
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
  await client.query(
    `INSERT INTO tenant_delegations (
       id, platform_organization_id, account_owner_organization_id
     ) VALUES ($1, $2, $3)`,
    [randomUUID(), APPROVED_TARGETS[0].organizationId, safeOrganizationId],
  )
  return {
    aliasReference,
    safeAssetId,
    safeAssetReference,
    safeDocumentId,
    safeShortLinkClickId: safeShortLinkClick.rows[0].id,
  }
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
    assert.equal(parsed.pathname, '/railway', 'Acceptance test requires a database named railway')
    databaseUrl = suppliedUrl
  } else {
    containerName = `clawpilot-tenant-retirement-${process.pid}-${randomUUID().slice(0, 8)}`
    command('docker', [
      'run', '--rm', '--detach',
      '--name', containerName,
      '--env', 'POSTGRES_PASSWORD=tenant_retirement_test',
      '--env', 'POSTGRES_DB=railway',
      '--publish', '127.0.0.1::5432',
      'postgres:16-alpine',
    ])
    const binding = command('docker', ['port', containerName, '5432/tcp'])
    const port = /:(\d+)$/u.exec(binding)?.[1]
    assert.ok(port, `Could not parse disposable PostgreSQL port: ${binding}`)
    databaseUrl = `postgresql://postgres:tenant_retirement_test@127.0.0.1:${port}/railway`
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
    RAILWAY_SERVICE_ID: PRODUCTION_RAILWAY_SERVICE_ID,
    RAILWAY_ENVIRONMENT_NAME: 'production',
    CLAWPILOT_TENANT_RETIRE_DATABASE_ENDPOINT_SHA256:
      databaseEndpointFingerprint(databaseUrl),
  }
  const databaseBoundaryRow = await pool.query(
    `SELECT current_database() AS database_name, current_user AS database_user,
            system_identifier::text AS postgres_system_identifier
     FROM pg_control_system()`,
  )
  const databaseBoundary = databaseBoundaryRow.rows[0]
  const testRuntime = {
    pool,
    testDatabaseBoundary: {
      databaseIdentity: PRODUCTION_DATABASE_IDENTITY,
      databaseName: databaseBoundary.database_name,
      databaseUser: databaseBoundary.database_user,
      postgresSystemIdentifier: databaseBoundary.postgres_system_identifier,
    },
  }
  const planPath = join(artifacts, 'reviewed-plan.json')
  const blockedPlanPath = join(artifacts, 'blocked-plan.json')
  const outboxBlockedPlanPath = join(artifacts, 'outbox-blocked-plan.json')
  const auditDriftBlockedPlanPath = join(artifacts, 'audit-drift-blocked-plan.json')
  const invalidIdentityPlanPath = join(artifacts, 'invalid-identity-plan.json')
  const receiptPath = join(artifacts, 'receipt.json')
  const missingMigrationPlanPath = join(artifacts, 'missing-migration-plan.json')
  const before = await pool.query('SELECT count(*)::integer AS count FROM workspace_organizations')
  const removedBoundaryMigration = await pool.query(
    `DELETE FROM schema_migrations
     WHERE filename = '0362_workspace_tenant_retirement_receipt_boundary_evidence.sql'
     RETURNING checksum`,
  )
  assert.equal(removedBoundaryMigration.rows.length, 1)
  await assert.rejects(
    () => run([
      ...commonFlags(), '--output', missingMigrationPlanPath,
    ], environment, testRuntime),
    /Migrations 0360_workspace_tenant_retirement_receipts\.sql and 0362_workspace_tenant_retirement_receipt_boundary_evidence\.sql are required/u,
  )
  await pool.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
    [
      '0362_workspace_tenant_retirement_receipt_boundary_evidence.sql',
      removedBoundaryMigration.rows[0].checksum,
    ],
  )
  await pool.query(
    'UPDATE workspace_organizations SET organization_type = $1 WHERE id = $2',
    ['member', APPROVED_TARGETS[0].organizationId],
  )
  await assert.rejects(
    () => run([
      ...commonFlags(), '--output', invalidIdentityPlanPath,
    ], environment, testRuntime),
    /scaffold identity mismatch/u,
  )
  await pool.query(
    'UPDATE workspace_organizations SET organization_type = $1 WHERE id = $2',
    ['root', APPROVED_TARGETS[0].organizationId],
  )
  const blocked = await run([
    ...commonFlags(), '--output', blockedPlanPath,
  ], environment, testRuntime)
  assert.equal(blocked.applyReady, false)
  const blockedManifest = JSON.parse(readFileSync(blockedPlanPath, 'utf8'))
  assert.deepEqual(blockedManifest.scope.blockers.crossTenantRows, [{
    table: 'tenant_delegations', column: 'account_owner_organization_id', count: 1,
  }])
  assert.deepEqual(blockedManifest.scope.blockers.unexpectedSelectedRelations, [{
    table: 'tenant_delegations', observed: 1,
  }])
  await pool.query('DELETE FROM tenant_delegations')
  const bakeryOutbox = await pool.query(
    `SELECT id::text FROM sync_outbox WHERE aggregate_id = $1`,
    [APPROVED_TARGETS[2].crmOrganizationId],
  )
  assert.equal(bakeryOutbox.rows.length, 1)
  await pool.query(
    `UPDATE sync_outbox SET aggregate_id = $1 WHERE id = $2::uuid`,
    [APPROVED_TARGETS[0].crmOrganizationId, bakeryOutbox.rows[0].id],
  )
  const outboxBlocked = await run([
    ...commonFlags(), '--output', outboxBlockedPlanPath,
  ], environment, testRuntime)
  assert.equal(outboxBlocked.applyReady, false)
  const outboxBlockedManifest = JSON.parse(readFileSync(outboxBlockedPlanPath, 'utf8'))
  assert.equal(
    outboxBlockedManifest.scope.blockers.unexpectedOutbox[0].reason,
    'audited_outbox_identity_multiset_mismatch',
  )
  await pool.query(
    `UPDATE sync_outbox SET aggregate_id = $1 WHERE id = $2::uuid`,
    [APPROVED_TARGETS[2].crmOrganizationId, bakeryOutbox.rows[0].id],
  )
  const auditDriftEventKey = 'fixture-audit-drift-extra'
  await pool.query(
    `INSERT INTO audit_events (
       actor, event_type, event_key, aggregate_type, aggregate_id,
       subject, organization_id, is_system, payload, created_at
     ) VALUES ('fixture', 'fixture.created', $1, 'workspace', $2::uuid::text,
       $3, $2::uuid, false, '{}'::jsonb, $4)`,
    [
      auditDriftEventKey,
      APPROVED_TARGETS[0].organizationId,
      APPROVED_TARGETS[0].name,
      fixedTime,
    ],
  )
  const auditDriftBlocked = await run([
    ...commonFlags(), '--output', auditDriftBlockedPlanPath,
  ], environment, testRuntime)
  assert.equal(auditDriftBlocked.applyReady, false)
  const auditDriftBlockedManifest = JSON.parse(
    readFileSync(auditDriftBlockedPlanPath, 'utf8'),
  )
  assert.deepEqual(auditDriftBlockedManifest.scope.blockers.unexpectedSpecialCounts, [{
    field: 'preservedAuditEvents',
    expected: EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents,
    observed: EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents + 1,
  }])
  await pool.query('DELETE FROM audit_events WHERE event_key = $1', [auditDriftEventKey])
  const planResult = await run([
    ...commonFlags(), '--output', planPath,
  ], environment, testRuntime)
  assert.equal(planResult.command, 'plan')
  assert.equal(planResult.applyReady, true)
  assert.equal(planResult.suiteCrmRecordsRetainedExternally, 6)
  const afterPlan = await pool.query('SELECT count(*)::integer AS count FROM workspace_organizations')
  assert.equal(afterPlan.rows[0].count, before.rows[0].count, 'Plan must be read-only')

  const manifest = JSON.parse(readFileSync(planPath, 'utf8'))
  assert.deepEqual(manifest.scope.counts, EXPECTED_SELECTED_SCOPE_COUNTS)
  assert.deepEqual(manifest.validatedBackup, {
    sha256: validatedBackupSha256,
    bytes: Number(validatedBackupBytes),
  })
  assert.equal(manifest.scope.disabledDeleteTriggers.length, 2)
  assert.ok(manifest.scope.disabledDeleteTriggers.some((trigger) => (
    trigger.table === 'short_link_clicks'
      && trigger.name === 'fixture_reject_short_link_click_delete'
  )))
  assert.equal(manifest.scope.shortLinks.length, 5)
  assert.equal(manifest.scope.preservedReferences.length, 1)
  assert.equal(manifest.scope.preservedReferences[0], PRESERVED_SHARED_REFERENCE_CODES[0])
  assert.equal(manifest.scope.blockers.relationCycles.length, 0)
  assert.equal(manifest.scope.blockers.preservedForeignKeys.length, 0)
  assert.equal(manifest.scope.blockers.crossTenantRows.length, 0)
  assert.equal(manifest.scope.blockers.unexpectedSelectedRelations.length, 0)
  assert.equal(manifest.scope.blockers.unclassifiedOrganizationRoles.length, 0)
  assert.ok(manifest.lockedRelations.some((relation) => relation.name === 'empty_tenant_relation'))
  assert.ok(manifest.organizationOwnership.roles.some((role) => (
    role.table === 'tenant_delegations'
      && role.column === 'account_owner_organization_id'
  )))

  const applyBase = [
    'apply', ...commonFlags(),
    '--manifest', planPath,
    '--confirm-digest', manifest.manifestDigest,
    '--receipt-output', receiptPath,
  ]
  await assert.rejects(
    () => run(
      applyBase.map((value) => value === validatedBackupSha256 ? 'e'.repeat(64) : value),
      environment,
      testRuntime,
    ),
    /Manifest execution boundary does not match/u,
  )
  await pool.query('CREATE TABLE post_plan_catalog_drift (id uuid PRIMARY KEY)')
  await assert.rejects(
    () => run(applyBase, environment, testRuntime),
    /relation lock catalog drifted/u,
  )
  await pool.query('DROP TABLE post_plan_catalog_drift')
  await pool.query(
    `UPDATE sync_outbox SET payload = '{"drift":true}'::jsonb
     WHERE aggregate_id = $1`,
    [APPROVED_TARGETS[0].crmOrganizationId],
  )
  await assert.rejects(
    () => run(applyBase, environment, testRuntime),
    /scope changed after plan approval/u,
  )
  await pool.query(
    `UPDATE sync_outbox SET payload = '{}'::jsonb
     WHERE aggregate_id = $1`,
    [APPROVED_TARGETS[0].crmOrganizationId],
  )
  await assert.rejects(
    () => run(applyBase, environment, testRuntime),
    /SuiteCRM is not called/u,
  )
  await assert.rejects(
    () => run([
      ...applyBase,
      '--acknowledge-suitecrm-retained', manifest.scope.suiteCrmDigest,
    ], environment, testRuntime),
    /Delete triggers are bypassed/u,
  )
  const afterRejectedApply = await pool.query(
    'SELECT count(*)::integer AS count FROM workspace_organizations',
  )
  assert.equal(afterRejectedApply.rows[0].count, before.rows[0].count)

  const applied = await run([
    ...applyBase,
    '--acknowledge-suitecrm-retained', manifest.scope.suiteCrmDigest,
    '--acknowledge-delete-triggers', manifest.scope.deleteTriggerDigest,
  ], environment, testRuntime)
  assert.equal(applied.command, 'apply')
  assert.equal(applied.verification.organizationsRemaining, 0)
  assert.equal(applied.verification.applicationUsersRemaining, 0)
  assert.equal(applied.verification.uuidOccurrences.length, 0)
  assert.equal(applied.verification.referenceOccurrences.length, 0)
  assert.equal(
    applied.verification.preservedAuditEvents,
    EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents,
  )
  assert.equal(applied.verification.preservation.ready, true)
  assert.equal(applied.verification.shortLinks.clicksRemaining, 0)

  const verified = await run([
    'verify', ...commonFlags(),
    '--manifest', planPath,
    '--confirm-digest', manifest.manifestDigest,
  ], environment, testRuntime)
  assert.equal(verified.ok, true)
  assert.equal(verified.suiteCrmRecordsRetainedExternally, 6)
  const replayReceiptPath = join(artifacts, 'receipt-replay.json')
  const replayed = await run([
    'apply', ...commonFlags(),
    '--manifest', planPath,
    '--confirm-digest', manifest.manifestDigest,
    '--receipt-output', replayReceiptPath,
  ], environment, testRuntime)
  assert.equal(replayed.ok, true)
  const firstArtifact = JSON.parse(readFileSync(receiptPath, 'utf8'))
  const replayArtifact = JSON.parse(readFileSync(replayReceiptPath, 'utf8'))
  const { idempotentReplay: firstReplay, ...firstComparable } = firstArtifact
  const { idempotentReplay: secondReplay, ...secondComparable } = replayArtifact
  assert.equal(firstReplay, false)
  assert.equal(secondReplay, true)
  assert.deepEqual(secondComparable, firstComparable)
  assert.equal(replayArtifact.idempotentReplay, true)
  const replayAudit = await pool.query(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE event_key = 'workspace-tenant-retirement:' || $1`,
    [manifest.manifestDigest],
  )
  assert.equal(replayAudit.rows[0].count, 1)
  const realDateNow = Date.now
  const futureNow = realDateNow() + (31 * 60 * 1000)
  Date.now = () => futureNow
  try {
    const expiredPlanVerification = await run([
      'verify', ...commonFlags(),
      '--manifest', planPath,
      '--confirm-digest', manifest.manifestDigest,
    ], environment, testRuntime)
    assert.equal(expiredPlanVerification.ok, true)
  } finally {
    Date.now = realDateNow
  }

  const targetIds = APPROVED_TARGETS.map((target) => target.organizationId)
  const remainingTargets = await pool.query(
    'SELECT count(*)::integer AS count FROM workspace_organizations WHERE id = ANY($1::uuid[])',
    [targetIds],
  )
  assert.equal(remainingTargets.rows[0].count, 0)
  for (const table of [
    'project_boards',
    'app_sessions',
    'crm_board_cards',
    'crm_board_projections',
    'crm_contact_source_aliases',
    'operations_activation_scopes',
    'pipeline_dropdown_catalogs',
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
  assert.equal(manifest.scope.userReplacements.length, 1)
  assert.equal(manifest.scope.userReplacements[0].email, CONFIRMED_OPERATOR_EMAIL)
  const operator = await pool.query(
    `SELECT organization_id::text, organization_name, contact_reference_code
     FROM app_users WHERE email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  assert.equal(
    operator.rows[0].organization_id,
    manifest.scope.userReplacements[0].replacementOrganizationId,
  )
  assert.equal(
    operator.rows[0].organization_name,
    manifest.scope.userReplacements[0].replacementOrganizationName,
  )
  assert.equal(operator.rows[0].contact_reference_code, PRESERVED_SHARED_REFERENCE_CODES[0])
  const operatorDefault = await pool.query(
    `SELECT organization_id::text
     FROM app_user_organization_memberships
     WHERE user_email = $1 AND is_default`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  assert.deepEqual(operatorDefault.rows.map((row) => row.organization_id), [
    manifest.scope.userReplacements[0].replacementOrganizationId,
  ])
  const reviewerDefault = await pool.query(
    `SELECT organization_id::text
     FROM app_user_organization_memberships
     WHERE user_email = $1 AND is_default`,
    [reviewerEmail],
  )
  assert.deepEqual(reviewerDefault.rows.map((row) => row.organization_id), [safeOrganizationId])
  const targetMemberships = await pool.query(
    `SELECT count(*)::integer AS count
     FROM app_user_organization_memberships
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  assert.equal(targetMemberships.rows[0].count, 0)
  const operatorMemberships = await pool.query(
    `SELECT count(*)::integer AS count
     FROM app_user_organization_memberships
     WHERE user_email = $1`,
    [CONFIRMED_OPERATOR_EMAIL],
  )
  assert.equal(operatorMemberships.rows[0].count, 4)
  const retiredReferences = await pool.query(
    `SELECT reference_code, status, retired_at
     FROM crm_reference_registry
     WHERE reference_code = ANY($1::text[])
     ORDER BY reference_code`,
    [manifest.scope.references],
  )
  assert.equal(retiredReferences.rows.length, manifest.scope.references.length)
  assert.ok(retiredReferences.rows.every((row) => row.status === 'retired' && row.retired_at))
  const sharedReference = await pool.query(
    `SELECT status, retired_at
     FROM crm_reference_registry
     WHERE reference_code = $1`,
    [PRESERVED_SHARED_REFERENCE_CODES[0]],
  )
  assert.deepEqual(sharedReference.rows[0], { status: 'active', retired_at: null })
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
  assert.deepEqual(linkState.rows[0], { total: 5, retired: 5 })
  const historicalAudits = await pool.query(
    `SELECT count(*)::integer AS count FROM audit_events
     WHERE organization_id = ANY($1::uuid[])`,
    [targetIds],
  )
  assert.equal(
    historicalAudits.rows[0].count,
    EXPECTED_SPECIAL_SCOPE_COUNTS.preservedAuditEvents,
    'Historical audit evidence is preserved',
  )
  const receipt = await pool.query(
    'SELECT id::text, retired_short_links FROM workspace_tenant_retirement_receipts',
  )
  assert.equal(receipt.rows.length, 1)
  assert.equal(receipt.rows[0].retired_short_links.length, 5)
  await assert.rejects(
    () => pool.query(
      `UPDATE workspace_tenant_retirement_receipts
       SET actor_email = 'changed@example.test' WHERE id = $1`,
      [receipt.rows[0].id],
    ),
    /immutable/u,
  )
  await pool.query(
    'ALTER TABLE workspace_tenant_retirement_receipts DISABLE TRIGGER reject_workspace_tenant_retirement_receipt_write',
  )
  await assert.rejects(
    () => run([
      'verify', ...commonFlags(),
      '--manifest', planPath,
      '--confirm-digest', manifest.manifestDigest,
    ], environment, testRuntime),
    /Migrations 0360_workspace_tenant_retirement_receipts\.sql and 0362_workspace_tenant_retirement_receipt_boundary_evidence\.sql are required/u,
  )
  await pool.query(
    `UPDATE workspace_tenant_retirement_receipts SET receipt_digest = $1 WHERE id = $2`,
    ['f'.repeat(64), receipt.rows[0].id],
  )
  await pool.query(
    'ALTER TABLE workspace_tenant_retirement_receipts ENABLE TRIGGER reject_workspace_tenant_retirement_receipt_write',
  )
  await assert.rejects(
    () => run([
      'verify', ...commonFlags(),
      '--manifest', planPath,
      '--confirm-digest', manifest.manifestDigest,
    ], environment, testRuntime),
    /receipt digest is invalid/u,
  )
  await assert.rejects(
    () => pool.query('DELETE FROM app_documents WHERE id = $1', [fixture.safeDocumentId]),
    /fixture document delete guard/u,
  )
  await assert.rejects(
    () => pool.query('DELETE FROM short_link_clicks WHERE id = $1', [fixture.safeShortLinkClickId]),
    /fixture short-link click delete guard/u,
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
