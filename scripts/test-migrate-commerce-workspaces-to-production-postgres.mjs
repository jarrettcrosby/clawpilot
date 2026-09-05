#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CONFIRMED_OWNER_EMAIL,
  SCRIPT_VERSION,
  SOURCE_DATABASE_IDENTITY,
  TARGET_DATABASE_IDENTITY,
  databaseEndpointFingerprint,
  digest,
  main as runMigration,
  targetScopeAudit,
  targetCounts,
} from './migrate-commerce-workspaces-to-production.mjs'

const root = process.cwd()
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const fixedTime = '2026-09-04T12:00:00.000Z'

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

function databaseUrl(port, database) {
  return `postgresql://postgres:commerce_migration@127.0.0.1:${port}/${database}`
}

function carrierAddressFingerprint(address) {
  return createHash('sha256')
    .update(JSON.stringify({
      line1: address.line1.trim().toLowerCase(),
      line2: address.line2?.trim().toLowerCase() || null,
      city: address.city.trim().toLowerCase(),
      region: address.region.trim().toLowerCase(),
      postalCode: address.postalCode.trim().toLowerCase().replace(/[\s-]/gu, ''),
      countryCode: address.countryCode.trim().toUpperCase(),
    }))
    .digest('hex')
}

function withDatabase(connectionString, database) {
  assert.match(database, /^[a-z][a-z0-9_]{2,62}$/u)
  const parsed = new URL(connectionString)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

async function tableExists(client, table) {
  return (await client.query(
    "SELECT to_regclass('public.' || $1) IS NOT NULL AS present",
    [table],
  )).rows[0]?.present === true
}

async function functionExists(client, name) {
  return (await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public' AND routine.proname = $1
     ) AS present`,
    [name],
  )).rows[0]?.present === true
}

async function installCapabilityStubs(client) {
  // The safety test must run on the migration commit by itself as well as on
  // the final release branch that contains the independently reviewed history
  // and storage migrations. These test-only shims never replace a real table
  // or function and live only in this disposable container.
  if (!await tableExists(client, 'operations_commerce_order_history_policies')) {
    await client.query(
      `CREATE TABLE operations_commerce_order_history_policies (
         organization_id uuid NOT NULL,
         integration_account_id uuid NOT NULL,
         PRIMARY KEY (organization_id, integration_account_id),
         FOREIGN KEY (organization_id, integration_account_id)
           REFERENCES operations_integration_accounts(organization_id, id)
           ON DELETE RESTRICT
       )`,
    )
  }
  await client.query(
    `ALTER TABLE operations_commerce_intake_read_intents
       ADD COLUMN IF NOT EXISTS response_purged_at timestamptz`,
  )
  await client.query(
    `ALTER TABLE operations_commerce_store_sync_read_leases
       ADD COLUMN IF NOT EXISTS history_exclusion_code text,
       ADD COLUMN IF NOT EXISTS history_excluded_external_order_id text,
       ADD COLUMN IF NOT EXISTS history_excluded_provider_created_at timestamptz`,
  )
  const definitions = [
    ['guard_commerce_order_history_lease_exclusion',
      `CREATE FUNCTION guard_commerce_order_history_lease_exclusion()
       RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`],
    ['purge_operations_commerce_intake_read_payloads',
      `CREATE FUNCTION purge_operations_commerce_intake_read_payloads()
       RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`],
    ['convert_operations_commerce_inventory_legacy_captures',
      `CREATE FUNCTION convert_operations_commerce_inventory_legacy_captures()
       RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`],
    ['purge_operations_commerce_inventory_observation_aliases',
      `CREATE FUNCTION purge_operations_commerce_inventory_observation_aliases()
       RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`],
    ['purge_operations_commerce_inventory_level_evidence',
      `CREATE FUNCTION purge_operations_commerce_inventory_level_evidence()
       RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`],
    ['operations_commerce_storage_bloat_health',
      `CREATE FUNCTION operations_commerce_storage_bloat_health(integer)
       RETURNS jsonb LANGUAGE sql AS 'SELECT jsonb_build_object(''ready'', true)'`],
  ]
  for (const [name, definition] of definitions) {
    if (!await functionExists(client, name)) await client.query(definition)
  }
}

async function allocate(client, prefix) {
  return (await client.query(
    'SELECT allocate_global_reference($1) AS reference',
    [prefix],
  )).rows[0].reference
}

async function reserveExactGlobalReference(client, referenceCode) {
  const match = /^(g[a-z]{1,4})((?:[0-9]{7}|[0-9a-v]{12}))$/u.exec(
    referenceCode,
  )
  assert.ok(match, `Invalid exact Global ID test fixture: ${referenceCode}`)
  const [, prefix, numberValue] = match
  await client.query(
    `INSERT INTO crm_reference_number_registry (number_value, allocated_at)
     VALUES ($1, $2)`,
    [numberValue, fixedTime],
  )
  await client.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at, entity_type
     )
     SELECT $1, $2, $1, 'active', $3, entity_type
     FROM global_reference_entity_types
     WHERE prefix = $2`,
    [referenceCode, prefix, fixedTime],
  )
  return referenceCode
}

async function seedActor(client) {
  await client.query(
    `INSERT INTO app_users (
       email, role, status, activated_at, display_name, created_at, updated_at
     ) VALUES ($1, 'owner', 'active', $2, 'Migration Owner', $2, $2)`,
    [CONFIRMED_OWNER_EMAIL, fixedTime],
  )
}

async function seedScaffold(client, label, primary = false, exactReference = null) {
  const organizationId = randomUUID()
  const organizationReference = exactReference
    ? await reserveExactGlobalReference(client, exactReference)
    : await allocate(client, 'ga')
  const pipelineId = randomUUID()
  const boards = [randomUUID(), randomUUID()]
  await client.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, reference_code, created_by, updated_by,
       created_at, updated_at
     ) VALUES ($1, $2, 'member', $3, $4, $4, $5, $5)`,
    [organizationId, `${label} workspace`, organizationReference,
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO pipeline_spaces (
       id, name, owner_email, sheet_id, sync_enabled,
       workspace_organization_id, created_at, updated_at
     ) VALUES ($1, $2, $3, NULL, false, $4, $5, $5)`,
    [pipelineId, `${label} pipeline`, CONFIRMED_OWNER_EMAIL,
      organizationId, fixedTime],
  )
  for (const [index, boardId] of boards.entries()) {
    await client.query(
      `INSERT INTO project_boards (
         id, name, owner_email, workspace_organization_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $5)`,
      [boardId, `${label} board ${index + 1}`, CONFIRMED_OWNER_EMAIL,
        organizationId, fixedTime],
    )
  }
  await client.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, status, is_default,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, 'owner', 'active', $3, $1, $1, $4, $4)`,
    [CONFIRMED_OWNER_EMAIL, organizationId, primary, fixedTime],
  )
  await client.query(
    `INSERT INTO pipeline_space_members (
       pipeline_id, user_email, access_role, shared_by, created_at, updated_at
     ) VALUES ($1, $2, 'editor', $2, $3, $3)`,
    [pipelineId, CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  for (const boardId of boards) {
    await client.query(
      `INSERT INTO project_board_members (
         board_id, user_email, access_role, shared_by, created_at, updated_at
       ) VALUES ($1, $2, 'editor', $2, $3, $3)`,
      [boardId, CONFIRMED_OWNER_EMAIL, fixedTime],
    )
  }
  if (primary) {
    await client.query(
      `UPDATE app_users
       SET organization_id = $2::uuid, organization_name = $3, updated_at = $4
       WHERE email = $1`,
      [CONFIRMED_OWNER_EMAIL, organizationId, `${label} workspace`, fixedTime],
    )
  }
  return { organizationId, organizationReference, pipelineId, boards }
}

async function seedSourceDomain(client, scaffold, index, reconnectEligible) {
  const integrationAccountId = randomUUID()
  const integrationAccountGlobalId = await allocate(client, 'gia')
  const externalAccountId = `verified-provider-store-${index}`
  const externalAccountIdSha256 = createHash('sha256')
    .update(externalAccountId)
    .digest('hex')
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, external_account_id, display_name, status,
       configuration, commerce_credential_generation,
       created_by, updated_by, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'shopify', 'commerce', 'production', $4, $5, 'active',
       '{"shopDomain":"fixture.myshopify.com"}'::jsonb, 1, $6, $6, $7, $7
     )`,
    [integrationAccountId, integrationAccountGlobalId, scaffold.organizationId,
      externalAccountId, `Synthetic store ${index}`, CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at,
       webhook_verification_status, webhook_verified_at,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, 'shopify_client_credentials', $4, $5, $6,
       1, 'test', 'verified', $7, 'verified', $7, $8, $8, $7, $7)`,
    [scaffold.organizationId, integrationAccountId, externalAccountId,
      Buffer.from('encrypted-test-only'), Buffer.alloc(12, 3), Buffer.alloc(16, 4),
      fixedTime, CONFIRMED_OWNER_EMAIL],
  )
  await client.query(
    `INSERT INTO operations_commerce_store_sync_controls (
       organization_id, integration_account_id, desired_state, explicit_choice,
       reason, created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, 'paused', true, 'Migration test cutover', $3, $3, $4, $4)
     ON CONFLICT (organization_id, integration_account_id) DO UPDATE SET
       desired_state = 'paused', explicit_choice = true,
       revision = operations_commerce_store_sync_controls.revision + 1,
       reason = EXCLUDED.reason, updated_by = EXCLUDED.updated_by,
       updated_at = clock_timestamp()`,
    [scaffold.organizationId, integrationAccountId, CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_commerce_workspace_migration_cutover_fences (
       organization_id, integration_account_id, migration_name, state,
       frozen_by, frozen_at, reason, created_at, updated_at
     ) VALUES ($1, $2, $3, 'frozen', $4, $5, $6, $5, $5)`,
    [scaffold.organizationId, integrationAccountId, SCRIPT_VERSION,
      CONFIRMED_OWNER_EMAIL, fixedTime, 'Disposable acceptance cutover'],
  )

  const warehouseId = randomUUID()
  const warehouseGlobalId = await allocate(client, 'gwh')
  await client.query(
    `INSERT INTO operations_warehouses (
       id, global_id, organization_id, code, name, timezone, address, status,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'America/New_York', '{}'::jsonb, 'active',
       $6, $6, $7, $7)`,
    [warehouseId, warehouseGlobalId, scaffold.organizationId, `WH-${index}`,
      `Warehouse ${index}`, CONFIRMED_OWNER_EMAIL, fixedTime],
  )

  const crmOrganizationId = randomUUID()
  const crmOrganizationReference = await allocate(client, 'ga')
  await client.query(
    `INSERT INTO crm_organizations (
       id, pipeline_id, source_key, identity_key, reference_code, name,
       relationship_type, source_payload, source_hash, sync_status,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $3, $4, $5, 'customer', $6::jsonb, $7, 'synced',
       $8, $8, $9, $9)`,
    [crmOrganizationId, scaffold.pipelineId, `fixture:organization:${index}`,
      crmOrganizationReference, `Customer ${index}`,
      JSON.stringify({ fixture: index, selected: true }), digest(`org-${index}`),
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  const contactId = randomUUID()
  const contactReference = await allocate(client, 'gc')
  await client.query(
    `INSERT INTO crm_contacts (
       id, pipeline_id, organization_id, source_key, identity_key,
       reference_code, full_name, first_name, last_name, email,
       source_payload, source_hash, sync_status,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9,
       $10::jsonb, $11, 'synced', $12, $12, $13, $13)`,
    [contactId, scaffold.pipelineId, crmOrganizationId,
      `fixture:contact:${index}`, contactReference, `Person ${index}`,
      'Person', String(index), `person${index}@example.test`,
      JSON.stringify({ fixture: index }), digest(`contact-${index}`),
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  const productId = randomUUID()
  const productReference = await allocate(client, 'gp')
  await client.query(
    `INSERT INTO crm_products (
       id, pipeline_id, source_key, reference_code, name, sku, price, cost,
       currency, description, source_payload, source_hash, sync_status,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 19.99, 7.25, 'USD', $7,
       $8::jsonb, $9, 'synced', $10, $10, $11, $11)`,
    [productId, scaffold.pipelineId, `fixture:product:${index}`,
      productReference, `ClawPilot test product ${index}`, `SKU-${index}`,
      `Product description ${index}`, JSON.stringify({ fixture: index }),
      digest(`product-${index}`), CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  const imageBytes = Buffer.from(`representative-image-${index}`)
  const imageHash = createHash('sha256').update(imageBytes).digest('hex')
  await client.query(
    `INSERT INTO crm_product_image_assets (
       id, organization_id, pipeline_id, product_id, asset_revision,
       content_bytes, mime_type, content_sha256, byte_length,
       pixel_width, pixel_height, alt_text, source, is_primary,
       created_by, updated_by, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 1, $5, 'image/png', $6, $7,
       20, 10, $8, 'manual_upload', true, $9, $9, $10, $10)`,
    [randomUUID(), scaffold.organizationId, scaffold.pipelineId, productId,
      imageBytes, imageHash, imageBytes.length, `Product ${index}`,
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_external_identifiers (
       organization_id, integration_account_id, entity_type,
       entity_global_id, external_id, status, match_method, match_evidence,
       last_verified_at, created_at
     ) VALUES ($1, $2, 'crm.organization', $3, $4, 'active', 'provider_id',
       $5::jsonb, $6, $6)`,
    [scaffold.organizationId, integrationAccountId, crmOrganizationReference,
      `external-customer-${index}`, JSON.stringify({ fixture: true }), fixedTime],
  )
  return {
    account: {
      id: integrationAccountId,
      globalId: integrationAccountGlobalId,
      provider: 'shopify',
      integrationType: 'commerce',
      environment: 'production',
      displayName: `Synthetic store ${index}`,
      externalAccountIdSha256,
      reconnectEligible,
    },
    externalAccountId,
    warehouseGlobalId,
    productId,
    imageBytes,
    imageHash,
  }
}

async function seedCarrierConnection(client, scaffold, options) {
  const integrationAccountId = randomUUID()
  const integrationAccountGlobalId = options.integrationGlobalId
    ? await reserveExactGlobalReference(client, options.integrationGlobalId)
    : await allocate(client, 'gia')
  const carrierAccountId = randomUUID()
  const carrierAccountGlobalId = options.carrierAccountGlobalId
    ? await reserveExactGlobalReference(client, options.carrierAccountGlobalId)
    : await allocate(client, 'gac')
  const address = options.address || {
    line1: '101 Jegs Place',
    line2: null,
    city: 'Mocksville',
    region: 'NC',
    postalCode: '27028',
    countryCode: 'US',
  }
  const addressFingerprint = carrierAddressFingerprint(address)
  const accountNumberFingerprint = digest({
    organizationId: scaffold.organizationId,
    provider: options.provider,
    environment: options.environment,
    accountNumberLastFour: options.accountNumberLastFour,
    fixture: options.displayName,
  })
  const configuration = options.configuration || {
    authMode: 'oauth_client_credentials',
    accountOwnerType: 'workspace',
    allowedCapabilities: options.environment === 'sandbox'
      ? ['sandbox_rate', 'sandbox_label']
      : ['production_rate', 'production_label'],
  }
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, external_account_id, display_name, status,
       configuration, commerce_credential_generation,
       created_by, updated_by, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'carrier', $5, NULL, $6, $7,
       $8::jsonb, 0, $9, $9, $10, $10
     )`,
    [integrationAccountId, integrationAccountGlobalId, scaffold.organizationId,
      options.provider, options.environment, options.displayName,
      options.status || 'active', JSON.stringify(configuration),
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four, account_number_last_four,
       verification_status, verified_at, created_by, updated_by,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, 1, 'test', $6,
       $7, CASE WHEN $7 = 'verified' THEN $9::timestamptz ELSE NULL END,
       $8, $8, $9, $9
     )`,
    [scaffold.organizationId, integrationAccountId,
      Buffer.from(`credential-${options.displayName}`), Buffer.alloc(12, 6),
      Buffer.alloc(16, 7), options.accountNumberLastFour,
      options.credentialVerification || 'verified', CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       encryption_version, account_number_last_four, account_number_fingerprint,
       registered_address, registered_address_fingerprint,
       address_verification, allow_sender_billing, allow_recipient_billing,
       allow_third_party_billing, status, created_by, updated_by,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'fixture-ciphertext', 'fixture-iv',
       'fixture-tag', 1, $7, $8, $9::jsonb, $10,
       'operator_attested', true, true, false, 'active', $11, $11, $12, $12
     )`,
    [carrierAccountId, carrierAccountGlobalId, scaffold.organizationId,
      integrationAccountId, options.accountDisplayName || options.displayName,
      options.senderName || 'Fixture Sender', options.accountNumberLastFour,
      accountNumberFingerprint, JSON.stringify(address), addressFingerprint,
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  if (options.cutover !== false) {
    await client.query(
      `INSERT INTO operations_commerce_workspace_migration_cutover_fences (
         organization_id, integration_account_id, migration_name, state,
         frozen_by, frozen_at, reason, created_at, updated_at
       ) VALUES ($1, $2, $3, 'frozen', $4, $5, $6, $5, $5)`,
      [scaffold.organizationId, integrationAccountId, SCRIPT_VERSION,
        CONFIRMED_OWNER_EMAIL, fixedTime, 'Disposable carrier acceptance cutover'],
    )
  }
  return {
    id: integrationAccountId,
    globalId: integrationAccountGlobalId,
    provider: options.provider,
    integrationType: 'carrier',
    environment: options.environment,
    displayName: options.displayName,
    reconnectEligible: true,
    carrierAccount: {
      id: carrierAccountId,
      globalId: carrierAccountGlobalId,
      displayName: options.accountDisplayName || options.displayName,
      senderName: options.senderName || 'Fixture Sender',
      sourceAccountNumberFingerprint: accountNumberFingerprint,
      sourceAddressFingerprint: addressFingerprint,
    },
    accountNumberLastFour: options.accountNumberLastFour,
    address,
  }
}

async function seedWorkspacePair(source, target, index, reconnectEligible) {
  const sourceScaffold = await seedScaffold(source, `source-${index}`, index === 1)
  const targetScaffold = await seedScaffold(target, `target-${index}`, index === 1)
  const domain = await seedSourceDomain(source, sourceScaffold, index, reconnectEligible)
  const carrierAccounts = []
  let targetSourceAuthority = null
  if (index === 1) {
    const authorityScaffold = await seedScaffold(
      target,
      'target-source-authority',
      false,
      'ga5122758',
    )
    const authority = await seedCarrierConnection(target, authorityScaffold, {
      provider: 'fedex_rest',
      environment: 'sandbox',
      integrationGlobalId: 'gia7335302',
      carrierAccountGlobalId: 'gac2368052',
      displayName: 'Existing verified sandbox source authority',
      accountDisplayName: 'Existing sandbox source shipper',
      senderName: 'Source Authority',
      accountNumberLastFour: '1073',
      cutover: false,
    })
    targetSourceAuthority = { scaffold: authorityScaffold, account: authority }
    const directCarrier = await seedCarrierConnection(source, sourceScaffold, {
      provider: 'ups_rest',
      environment: 'production',
      displayName: 'Synthetic direct UPS production',
      accountDisplayName: 'Synthetic direct UPS shipper',
      senderName: 'Synthetic Warehouse',
      accountNumberLastFour: '3574',
    })
    const managedCarrier = await seedCarrierConnection(source, sourceScaffold, {
      provider: 'fedex_rest',
      environment: 'sandbox',
      displayName: 'Synthetic source-managed FedEx sandbox',
      accountDisplayName: 'Synthetic delegated FedEx shipper',
      senderName: 'Synthetic Warehouse',
      accountNumberLastFour: authority.accountNumberLastFour,
      address: authority.address,
      configuration: {
        authMode: 'oauth_client_credentials',
        accountOwnerType: 'delegated_source',
        allowedCapabilities: ['sandbox_rate', 'sandbox_label'],
        managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
        authorizationScope: 'sandbox_fulfillment_diagnostic',
        credentialRevealAllowed: false,
        delegatedFromOrganizationReferenceCode: 'ga0000000',
        sourceIntegrationGlobalId: 'gia0000000',
        sourceCarrierAccountGlobalId: 'gac0000000',
        senderOriginWarehouseGlobalId: domain.warehouseGlobalId,
      },
    })
    managedCarrier.sourceAuthority = {
      organizationReference: authorityScaffold.organizationReference,
      integrationGlobalId: authority.globalId,
      carrierAccountGlobalId: authority.carrierAccount.globalId,
      accountNumberLastFour: authority.accountNumberLastFour,
      registeredAddressLine1: authority.address.line1,
    }
    carrierAccounts.push(directCarrier, managedCarrier)
  }
  return {
    workspace: {
      key: `synthetic-${index}`,
      source: {
        organizationId: sourceScaffold.organizationId,
        organizationReference: sourceScaffold.organizationReference,
        pipelineId: sourceScaffold.pipelineId,
        boards: sourceScaffold.boards,
        warehouseGlobalId: domain.warehouseGlobalId,
        excludedOrganizationReferences: [],
        excludedContactReferences: [],
        excludedWarehouseGlobalIds: [],
        excludedAccounts: [],
        accounts: [domain.account, ...carrierAccounts],
      },
      target: {
        organizationId: targetScaffold.organizationId,
        organizationReference: targetScaffold.organizationReference,
        pipelineId: targetScaffold.pipelineId,
        boardMap: Object.fromEntries(sourceScaffold.boards.map((id, boardIndex) => (
          [id, targetScaffold.boards[boardIndex]]
        ))),
      },
    },
    sourceScaffold,
    targetScaffold,
    domain,
    carrierAccounts,
    targetSourceAuthority,
  }
}

async function seedSourceBlockers(client, fixture) {
  const { organizationId } = fixture.sourceScaffold
  const { id: accountId } = fixture.domain.account
  const receipt = await client.query(
    `INSERT INTO operations_commerce_webhook_receipts (
       organization_id, integration_account_id, provider, credential_version,
       provider_event_id, topic, source_domain, payload_hash,
       payload_ciphertext, payload_iv, payload_tag, payload_bytes,
       state, processed_at, last_error_code
     ) VALUES ($1, $2, 'shopify', 1, 'event0001', 'orders/updated',
       'fixture.myshopify.com', $3, $4, $5, $6, 2,
       'dead_letter', clock_timestamp(), 'TEST_DEAD_LETTER')
     RETURNING global_id`,
    [organizationId, accountId, digest('webhook-payload'), Buffer.from('{}'),
      Buffer.alloc(12, 1), Buffer.alloc(16, 2)],
  )
  await client.query(
    `INSERT INTO operations_commerce_order_sync_policies (
       organization_id, integration_account_id, continuous_transport,
       provider_event_processor_state, revision, created_by, updated_by
     ) VALUES ($1, $2, 'webhook_signal_plus_poll', 'available', 1, $3, $3)`,
    [organizationId, accountId, CONFIRMED_OWNER_EMAIL],
  )
  const signal = await client.query(
    `INSERT INTO operations_shopify_order_webhook_signals (
       organization_id, integration_account_id, credential_generation,
       policy_revision, provider_event_id, topic, source_domain,
       external_order_id, provider_updated_at, payload_hash, payload_bytes,
       received_at
     ) VALUES ($1, $2, 1, 1, 'signal0001', 'orders/updated',
       'fixture.myshopify.com', 'gid://shopify/Order/1001', $3, $4, 2, $3)
     RETURNING global_id`,
    [organizationId, accountId, fixedTime, digest('signal-payload')],
  )
  await client.query(
    `INSERT INTO operations_shopify_order_webhook_targets (
       organization_id, integration_account_id, external_order_id,
       credential_generation, policy_revision, dirty_version,
       reconciled_version, latest_signal_global_id,
       latest_provider_updated_at, last_signaled_at, claim_state
     ) VALUES ($1, $2, 'gid://shopify/Order/1001', 1, 1, 1, 0, $3, $4, $4, 'pending')`,
    [organizationId, accountId, signal.rows[0].global_id, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_shopify_catalog_refresh_states (
       organization_id, integration_account_id, credential_generation,
       dirty_version, reconciled_version, last_receipt_global_id,
       last_signaled_at
     ) VALUES ($1, $2, 1, 1, 0, $3, $4)`,
    [organizationId, accountId, receipt.rows[0].global_id, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_shopify_inventory_refresh_watermarks (
       organization_id, integration_account_id, credential_generation,
       dirty_version, reconciled_version, last_receipt_global_id,
       last_signaled_at
     ) VALUES ($1, $2, 1, 1, 0, $3, $4)`,
    [organizationId, accountId, receipt.rows[0].global_id, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_commerce_provider_attempts (
       organization_id, integration_account_id, action, adapter_version,
       idempotency_key, request_hash, state, requested_at, created_by
     ) VALUES ($1, $2, 'fixture-read', 'fixture-v1', 'fixture-attempt',
       $3, 'prepared', $4, $5)`,
    [organizationId, accountId, digest('fixture-provider-request'), fixedTime,
      CONFIRMED_OWNER_EMAIL],
  )
  await client.query(
    `INSERT INTO operations_commerce_product_intake_policies (
       organization_id, integration_account_id, revision, created_by, updated_by
     ) VALUES ($1, $2, 1, $3, $3)`,
    [organizationId, accountId, CONFIRMED_OWNER_EMAIL],
  )
  await client.query(
    `INSERT INTO operations_commerce_catalog_sync_jobs (
       organization_id, integration_account_id, provider,
       credential_version, policy_revision, requested_by, status
     ) VALUES ($1, $2, 'shopify', 1, 1, $3, 'pending')`,
    [organizationId, accountId, CONFIRMED_OWNER_EMAIL],
  )
}

async function clearSourceBlockers(client, fixture) {
  const { organizationId } = fixture.sourceScaffold
  const { id: accountId } = fixture.domain.account
  await client.query(
    `UPDATE operations_commerce_webhook_receipts
     SET state = 'succeeded', last_error_code = NULL
     WHERE organization_id = $1 AND integration_account_id = $2`,
    [organizationId, accountId],
  )
  await client.query(
    `UPDATE operations_shopify_catalog_refresh_states
     SET reconciled_version = dirty_version, last_reconciled_at = clock_timestamp()
     WHERE organization_id = $1 AND integration_account_id = $2`,
    [organizationId, accountId],
  )
  await client.query(
    `UPDATE operations_shopify_inventory_refresh_watermarks
     SET reconciled_version = dirty_version, last_reconciled_at = clock_timestamp()
     WHERE organization_id = $1 AND integration_account_id = $2`,
    [organizationId, accountId],
  )
  await client.query(
    `UPDATE operations_commerce_provider_attempts
     SET state = 'succeeded', completed_at = clock_timestamp()
     WHERE organization_id = $1 AND integration_account_id = $2
       AND state = 'prepared'`,
    [organizationId, accountId],
  )
  // This is deliberately test-fixture cleanup, not a production recovery
  // instruction. The live table enforces an evidence-backed immutable state
  // machine, so remove only the disposable row after proving the migration
  // detects it.
  await client.query(
    `ALTER TABLE operations_shopify_order_webhook_targets
       DISABLE TRIGGER protect_shopify_order_webhook_target_write`,
  )
  try {
    await client.query(
      `DELETE FROM operations_shopify_order_webhook_targets
       WHERE organization_id = $1 AND integration_account_id = $2`,
      [organizationId, accountId],
    )
  } finally {
    await client.query(
      `ALTER TABLE operations_shopify_order_webhook_targets
         ENABLE TRIGGER protect_shopify_order_webhook_target_write`,
    )
  }
  await client.query(
    `UPDATE operations_commerce_catalog_sync_jobs
     SET status = 'succeeded', completed_at = clock_timestamp()
     WHERE organization_id = $1 AND integration_account_id = $2`,
    [organizationId, accountId],
  )
}

async function seedTemporaryTargetRow(client, fixture) {
  const id = randomUUID()
  const globalId = await allocate(client, 'gwh')
  await client.query(
    `INSERT INTO operations_warehouses (
       id, global_id, organization_id, code, name, address,
       created_by, updated_by
     ) VALUES ($1, $2, $3, 'UNEXPECTED', 'Unexpected target row', '{}'::jsonb,
       $4, $4)`,
    [id, globalId, fixture.targetScaffold.organizationId, CONFIRMED_OWNER_EMAIL],
  )
  return id
}

function migrationEnvironment(sourceUrl, targetUrl) {
  return {
    ...process.env,
    PGSSLMODE: 'disable',
    SOURCE_DATABASE_URL: sourceUrl,
    TARGET_DATABASE_URL: targetUrl,
    SOURCE_DATABASE_ENDPOINT_SHA256: databaseEndpointFingerprint(sourceUrl),
    TARGET_DATABASE_ENDPOINT_SHA256: databaseEndpointFingerprint(targetUrl),
  }
}

function planArguments(path) {
  return [
    'plan', '--actor', CONFIRMED_OWNER_EMAIL,
    '--images', 'current', '--output', path,
  ]
}

function applyArguments(manifest, digestValue, mapping) {
  return [
    'apply', '--actor', CONFIRMED_OWNER_EMAIL,
    '--manifest', manifest, '--confirm-digest', digestValue,
    '--mapping-output', mapping,
  ]
}

function exportArguments(manifest, digestValue, mapping) {
  return [
    'receipt-export', '--actor', CONFIRMED_OWNER_EMAIL,
    '--manifest', manifest, '--confirm-digest', digestValue,
    '--mapping-output', mapping,
  ]
}

function assertPrivateFile(path) {
  assert.equal(statSync(path).mode & 0o077, 0, `${path} must be mode 0600`)
}

async function count(client, sql, params = []) {
  return Number((await client.query(sql, params)).rows[0].count)
}

async function materializeTargetCarrier(client, fixture, migrationResult, sourceAccount) {
  const integrationAccountId = migrationResult.mapping.operations_integration_accounts[
    sourceAccount.id
  ].id
  const placeholderIdentity = migrationResult.mapping[
    'operations_carrier_account_migration_placeholders'
  ][sourceAccount.carrierAccount.id]
  const targetFingerprint = digest({
    organizationId: fixture.targetScaffold.organizationId,
    integrationAccountId,
    sourceGlobalId: sourceAccount.globalId,
    targetReauthentication: true,
  })
  const placeholder = (await client.query(
    `SELECT display_name, sender_name, source_account_number_last_four,
            source_registered_address_fingerprint, rebind_mode
     FROM operations_carrier_account_migration_placeholders
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
    [fixture.targetScaffold.organizationId, integrationAccountId],
  )).rows[0]
  assert.ok(placeholder)

  await assert.rejects(
    client.query(
      `UPDATE operations_integration_accounts SET status = 'active'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.targetScaffold.organizationId, integrationAccountId],
    ),
    /provider and shipper identity is not verified/iu,
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four, account_number_last_four,
       verification_status, verified_at, created_by, updated_by,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, 1, 'new1', NULL,
       'verified', $7, $6, $6, $7, $7
     )`,
    [fixture.targetScaffold.organizationId, integrationAccountId,
      Buffer.from(`fresh-target-credential-${sourceAccount.globalId}`),
      Buffer.alloc(12, 8), Buffer.alloc(16, 9),
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv, account_number_tag,
       encryption_version, account_number_last_four, account_number_fingerprint,
       registered_address, registered_address_fingerprint,
       address_verification, allow_sender_billing, allow_recipient_billing,
       allow_third_party_billing, status, created_by, updated_by,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       'fresh-target-account-ciphertext', 'fresh-target-account-iv',
       'fresh-target-account-tag', 1, $7, $8, $9::jsonb, $10,
       'operator_attested', true, false, false, 'active', $11, $11, $12, $12
     )`,
    [placeholderIdentity.id, placeholderIdentity.reference,
      fixture.targetScaffold.organizationId, integrationAccountId,
      placeholder.display_name, placeholder.sender_name,
      placeholder.source_account_number_last_four, targetFingerprint,
      JSON.stringify(sourceAccount.address),
      placeholder.source_registered_address_fingerprint,
      CONFIRMED_OWNER_EMAIL, fixedTime],
  )
  await assert.rejects(
    client.query(
      `UPDATE operations_carrier_account_migration_placeholders
       SET state = 'materialized',
           target_account_number_fingerprint = $3,
           materialized_by = $4,
           materialized_at = clock_timestamp()
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [fixture.targetScaffold.organizationId, integrationAccountId,
        digest('wrong-target-carrier-fingerprint'), CONFIRMED_OWNER_EMAIL],
    ),
    /verified target credential and exact shipper identity/iu,
  )
  await client.query(
    `UPDATE operations_carrier_account_migration_placeholders
     SET state = 'materialized',
         target_account_number_fingerprint = $3,
         materialized_by = $4,
         materialized_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
    [fixture.targetScaffold.organizationId, integrationAccountId,
      targetFingerprint, CONFIRMED_OWNER_EMAIL],
  )
  await client.query(
    `UPDATE operations_commerce_migration_provider_identity_fences
     SET verification_state = 'verified',
         verified_carrier_account_id = $3::uuid,
         verified_carrier_account_identity_sha256 = $4,
         verified_by = $5,
         verified_at = clock_timestamp()
     WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
    [fixture.targetScaffold.organizationId, integrationAccountId,
      placeholderIdentity.id, targetFingerprint, CONFIRMED_OWNER_EMAIL],
  )
  const capabilities = sourceAccount.sourceAuthority
    ? ['sandbox_rate', 'sandbox_label']
    : sourceAccount.environment === 'production'
      ? ['production_rate', 'production_label']
      : ['sandbox_rate', 'sandbox_label']
  const configurationPatch = sourceAccount.sourceAuthority
    ? { migrationSourceAuthorityVerified: true, allowedCapabilities: capabilities }
    : { allowedCapabilities: capabilities }
  await client.query(
    `UPDATE operations_integration_accounts
     SET status = 'active',
         credential_reference = $3,
         configuration = configuration || $4::jsonb
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [fixture.targetScaffold.organizationId, integrationAccountId,
      `carrier-credential:${integrationAccountId}:v1`,
      JSON.stringify(configurationPatch)],
  )
  return { integrationAccountId, placeholderIdentity, targetFingerprint }
}

async function runAcceptance(sourceUrl, targetUrl, directory) {
  process.env.PGSSLMODE = 'disable'
  const environment = migrationEnvironment(sourceUrl, targetUrl)
  const source = new Pool({ connectionString: sourceUrl, max: 2 })
  const target = new Pool({ connectionString: targetUrl, max: 2 })
  try {
    await Promise.all([
      source.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('deployment.database.identity', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify({ id: SOURCE_DATABASE_IDENTITY }), fixedTime],
      ),
      target.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('deployment.database.identity', $1::jsonb, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify({ id: TARGET_DATABASE_IDENTITY }), fixedTime],
      ),
    ])
    await Promise.all([seedActor(source), seedActor(target)])
    const fixtures = []
    fixtures.push(await seedWorkspacePair(source, target, 1, true))
    fixtures.push(await seedWorkspacePair(source, target, 2, false))
    const workspaces = fixtures.map((fixture) => fixture.workspace)
    const runtime = { workspaces }

    await seedSourceBlockers(source, fixtures[0])
    await target.query(
      `CREATE TABLE operations_migration_scope_probe (
         id uuid PRIMARY KEY,
         organization_id uuid,
         pipeline_id uuid
       )`,
    )
    const organizationScopedProbeId = randomUUID()
    await target.query(
      `INSERT INTO operations_migration_scope_probe (
         id, organization_id, pipeline_id
       ) VALUES ($1, $2, $3)`,
      [
        organizationScopedProbeId,
        fixtures[0].targetScaffold.organizationId,
        randomUUID(),
      ],
    )
    const exactScopedCounts = await targetCounts(target, fixtures[0].workspace)
    assert.equal(exactScopedCounts.operations_migration_scope_probe, 1)
    await target.query(
      'DELETE FROM operations_migration_scope_probe WHERE id = $1',
      [organizationScopedProbeId],
    )
    await target.query(
      `CREATE TABLE operations_migration_indirect_parent (
         id uuid PRIMARY KEY,
         organization_id uuid NOT NULL
           REFERENCES workspace_organizations(id)
       )`,
    )
    for (let depth = 1; depth <= 10; depth += 1) {
      const table = `operations_migration_indirect_${String(depth).padStart(2, '0')}`
      const parent = depth === 1
        ? 'operations_migration_indirect_parent'
        : `operations_migration_indirect_${String(depth - 1).padStart(2, '0')}`
      await target.query(
        `CREATE TABLE ${table} (
           id uuid PRIMARY KEY,
           parent_id uuid NOT NULL REFERENCES ${parent}(id)
         )`,
      )
    }
    const indirectParentId = randomUUID()
    await target.query(
      `INSERT INTO operations_migration_indirect_parent (id, organization_id)
       VALUES ($1, $2)`,
      [
        indirectParentId,
        fixtures[0].targetScaffold.organizationId,
      ],
    )
    let indirectRowId = indirectParentId
    for (let depth = 1; depth <= 10; depth += 1) {
      const nextId = randomUUID()
      const table = `operations_migration_indirect_${String(depth).padStart(2, '0')}`
      await target.query(
        `INSERT INTO ${table} (id, parent_id) VALUES ($1, $2)`,
        [nextId, indirectRowId],
      )
      indirectRowId = nextId
    }
    const indirectScope = await targetScopeAudit(target, fixtures[0].workspace)
    assert.equal(indirectScope.counts.operations_migration_indirect_10, 1)
    assert.equal(indirectScope.classifications.find((item) => (
      item.table === 'operations_migration_indirect_10'
    ))?.strategy, 'indirect')
    for (let depth = 10; depth >= 1; depth -= 1) {
      const table = `operations_migration_indirect_${String(depth).padStart(2, '0')}`
      await target.query(`DROP TABLE ${table}`)
    }
    await target.query('DROP TABLE operations_migration_indirect_parent')

    const jsonScopeOutbox = await target.query(
      `INSERT INTO sync_outbox (
         aggregate_type, aggregate_id, operation, target_system, payload,
         status, idempotency_key
       ) VALUES (
         'migration_scope_probe', $1, 'scope_probe', 'suitecrm', $2::jsonb,
         'queued', $3
       ) RETURNING id::text`,
      [
        fixtures[0].targetScaffold.organizationId,
        JSON.stringify({
          organizationId: fixtures[0].targetScaffold.organizationId,
        }),
        `migration-scope-probe:${randomUUID()}`,
      ],
    )
    const jsonScope = await targetScopeAudit(target, fixtures[0].workspace)
    assert.equal(jsonScope.counts.sync_outbox, 1)
    assert.equal(jsonScope.classifications.find((item) => (
      item.table === 'sync_outbox'
    ))?.strategy, 'explicit-json')
    await target.query('DELETE FROM sync_outbox WHERE id = $1', [jsonScopeOutbox.rows[0].id])

    await target.query(
      `CREATE TABLE operations_migration_unclassifiable_probe (
         id uuid PRIMARY KEY,
         opaque_scope text NOT NULL
       )`,
    )
    const deniedScope = await targetScopeAudit(target, fixtures[0].workspace)
    assert.ok(deniedScope.denied.includes('operations_migration_unclassifiable_probe'))
    await assert.rejects(
      targetCounts(target, fixtures[0].workspace),
      /classification denied candidate tables.*operations_migration_unclassifiable_probe/iu,
    )
    await target.query('DROP TABLE operations_migration_unclassifiable_probe')
    const unexpectedTargetId = await seedTemporaryTargetRow(target, fixtures[0])
    const blockedPlanPath = join(directory, 'blocked-plan.json')
    const blockedPlan = await runMigration(
      planArguments(blockedPlanPath), environment, runtime)
    assert.equal(blockedPlan.applyReady, false)
    assert.equal(blockedPlan.workspaces[0].targetCounts.operations_warehouses, 1)
    assert.deepEqual(
      blockedPlan.workspaces[0].sourceBlockers.actionableWebhooks
        .map((row) => row.state),
      ['dead_letter'],
    )
    assert.equal(
      blockedPlan.workspaces[0].sourceBlockers.dirtyReconciliation
        .find((item) => item.table === 'operations_shopify_order_webhook_targets')
        .rows[0].count,
      1,
    )
    for (const table of [
      'operations_shopify_catalog_refresh_states',
      'operations_shopify_inventory_refresh_watermarks',
    ]) {
      assert.equal(
        blockedPlan.workspaces[0].sourceBlockers.dirtyReconciliation
          .find((item) => item.table === table).rows[0].count,
        1,
      )
    }
    assert.equal(
      blockedPlan.workspaces[0].sourceBlockers.heldWork
        .find((item) => item.table === 'operations_commerce_provider_attempts')
        .rows[0].state,
      'prepared',
    )
    assert.equal(
      blockedPlan.workspaces[0].sourceBlockers.heldWork
        .find((item) => item.table === 'operations_commerce_catalog_sync_jobs')
        .rows[0].state,
      'pending',
    )
    assertPrivateFile(blockedPlanPath)
    await clearSourceBlockers(source, fixtures[0])
    await target.query('DELETE FROM operations_warehouses WHERE id = $1', [unexpectedTargetId])

    await target.query(
      `UPDATE operations_integration_accounts SET status = 'disabled'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixtures[0].targetSourceAuthority.scaffold.organizationId,
        fixtures[0].targetSourceAuthority.account.id],
    )
    const authorityBlockedPlanPath = join(directory, 'authority-blocked-plan.json')
    const authorityBlockedPlan = await runMigration(
      planArguments(authorityBlockedPlanPath),
      environment,
      runtime,
    )
    assert.equal(authorityBlockedPlan.applyReady, false)
    assert.equal(
      authorityBlockedPlan.workspaces[0].sourceAuthorityDependencies[0].ready,
      false,
    )
    assert.match(
      authorityBlockedPlan.workspaces[0].sourceAuthorityDependencies[0].blocker,
      /source carrier authority is absent, inactive, unverified, or identity-mismatched/iu,
    )
    await target.query(
      `UPDATE operations_integration_accounts SET status = 'active'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixtures[0].targetSourceAuthority.scaffold.organizationId,
        fixtures[0].targetSourceAuthority.account.id],
    )

    const planPath = join(directory, 'ready-plan.json')
    const plan = await runMigration(planArguments(planPath), environment, runtime)
    assert.equal(plan.applyReady, true)
    assert.ok(plan.workspaces.every((workspace) => workspace.targetEmpty && workspace.ready))
    assert.equal(plan.workspaces[0].accounts.length, 3)
    assert.equal(plan.workspaces[0].sourceAuthorityDependencies.length, 1)
    assert.deepEqual(
      plan.workspaces[0].sourceAuthorityDependencies[0],
      {
        targetIntegrationSourceGlobalId: fixtures[0].carrierAccounts[1].globalId,
        provider: 'fedex_rest',
        environment: 'sandbox',
        requiredOrganizationReference: 'ga5122758',
        requiredIntegrationGlobalId: 'gia7335302',
        requiredCarrierAccountGlobalId: 'gac2368052',
        requiredAccountNumberLastFour: '1073',
        requiredRegisteredAddressFingerprint:
          fixtures[0].carrierAccounts[1].carrierAccount.sourceAddressFingerprint,
        authorityOrganizationId:
          fixtures[0].targetSourceAuthority.scaffold.organizationId,
        authorityIntegrationAccountId:
          fixtures[0].targetSourceAuthority.account.id,
        authorityCarrierAccountId:
          fixtures[0].targetSourceAuthority.account.carrierAccount.id,
        ready: true,
        blocker: null,
      },
    )
    for (const carrierPlan of plan.workspaces[0].accounts.filter((account) => (
      account.integrationType === 'carrier'
    ))) {
      assert.deepEqual(carrierPlan.safeConfiguration.allowedCapabilities, [])
      assert.equal(carrierPlan.safeConfiguration.migrationRequiresCredentialRebind, true)
      assert.equal(
        carrierPlan.safeConfiguration.migrationRequiresProviderIdentityVerification,
        true,
      )
      assert.equal(JSON.stringify(carrierPlan).includes('credential-ciphertext'), false)
    }
    assertPrivateFile(planPath)

    await target.query(
      `UPDATE workspace_organizations SET name = name || ' drift'
       WHERE id = $1`,
      [fixtures[0].targetScaffold.organizationId],
    )
    const driftMapping = join(directory, 'drift-mapping.json')
    await assert.rejects(
      runMigration(
        applyArguments(planPath, plan.manifestDigest, driftMapping),
        environment,
        runtime,
      ),
      /target configuration changed after the reviewed plan/u,
    )
    assert.equal(existsSync(driftMapping), false)
    assert.equal(await count(target,
      `SELECT count(*) FROM audit_events
       WHERE event_type = 'operations.commerce_workspace_migration.completed'`), 0)
    await target.query(
      `UPDATE workspace_organizations SET name = $2 WHERE id = $1`,
      [fixtures[0].targetScaffold.organizationId, 'target-1 workspace'],
    )

    await target.query(
      `CREATE FUNCTION migration_test_fail_second_image()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'intentional second workspace image failure';
       END;
       $$`,
    )
    await target.query(
      `CREATE TRIGGER migration_test_fail_second_image
       BEFORE INSERT ON crm_product_image_assets
       FOR EACH ROW WHEN (NEW.pipeline_id = '${fixtures[1].targetScaffold.pipelineId}'::uuid)
       EXECUTE FUNCTION migration_test_fail_second_image()`,
    )
    const partialMapping = join(directory, 'partial-mapping.json')
    await assert.rejects(
      runMigration(
        applyArguments(planPath, plan.manifestDigest, partialMapping),
        environment,
        runtime,
      ),
      /intentional second workspace image failure/u,
    )
    assert.equal(existsSync(partialMapping), false)
    assert.equal(await count(target,
      `SELECT count(*) FROM audit_events
       WHERE event_type = 'operations.commerce_workspace_migration.completed'
         AND organization_id = $1`,
      [fixtures[0].targetScaffold.organizationId]), 1)
    assert.equal(await count(target,
      `SELECT count(*) FROM audit_events
       WHERE event_type = 'operations.commerce_workspace_migration.completed'
         AND organization_id = $1`,
      [fixtures[1].targetScaffold.organizationId]), 0)
    assert.equal(await count(target,
      'SELECT count(*) FROM crm_products WHERE pipeline_id = $1',
      [fixtures[1].targetScaffold.pipelineId]), 0)
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_integration_accounts
       WHERE organization_id = $1`,
      [fixtures[1].targetScaffold.organizationId]), 0)
    await target.query('DROP TRIGGER migration_test_fail_second_image ON crm_product_image_assets')
    await target.query('DROP FUNCTION migration_test_fail_second_image()')

    const mappingPath = join(directory, 'mapping.json')
    const applied = await runMigration(
      applyArguments(planPath, plan.manifestDigest, mappingPath),
      environment,
      runtime,
    )
    assert.deepEqual(applied.results.map((result) => result.disposition), [
      'already_applied', 'applied',
    ])
    assertPrivateFile(mappingPath)
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'))
    assert.deepEqual(mapping.results.map((result) => result.disposition), [
      'already_applied', 'applied',
    ])

    for (const [index, fixture] of fixtures.entries()) {
      const result = mapping.results[index]
      const targetProductId = result.mapping.crm_products[fixture.domain.productId].id
      const targetAccountId = result.mapping.operations_integration_accounts[
        fixture.domain.account.id
      ].id
      assert.equal(await count(target,
        'SELECT count(*) FROM sync_outbox WHERE aggregate_id = $1',
        [targetProductId]), 1)
      const product = (await target.query(
        `SELECT source_hash, suitecrm_id, source_payload
         FROM crm_products WHERE id = $1`,
        [targetProductId],
      )).rows[0]
      assert.notEqual(product.source_hash, digest(`product-${index + 1}`))
      assert.match(product.suitecrm_id, /^[0-9a-f-]{36}$/u)
      const image = (await target.query(
        `SELECT content_sha256, byte_length,
                encode(digest(content_bytes, 'sha256'), 'hex') AS observed_hash
         FROM crm_product_image_assets WHERE product_id = $1`,
        [targetProductId],
      )).rows[0]
      assert.equal(image.content_sha256, fixture.domain.imageHash)
      assert.equal(image.observed_hash, fixture.domain.imageHash)
      assert.equal(Number(image.byte_length), fixture.domain.imageBytes.length)
      const externalIdentifier = (await target.query(
        `SELECT status, last_verified_at, match_evidence
         FROM operations_external_identifiers
         WHERE organization_id = $1 AND integration_account_id = $2`,
        [fixture.targetScaffold.organizationId, targetAccountId],
      )).rows[0]
      assert.equal(externalIdentifier.status, 'stale')
      assert.ok(externalIdentifier.last_verified_at)
      assert.equal(externalIdentifier.match_evidence.migrationProviderIdentityFence, true)
      const placeholder = (await target.query(
        `SELECT status, external_account_id, credential_reference,
                commerce_credential_generation, receipt_intake_enabled
         FROM operations_integration_accounts WHERE id = $1`,
        [targetAccountId],
      )).rows[0]
      assert.deepEqual(placeholder, {
        status: 'disabled',
        external_account_id: null,
        credential_reference: null,
        commerce_credential_generation: 0,
        receipt_intake_enabled: false,
      })
    }
    for (const fixture of fixtures) {
      assert.equal(await count(target,
        `SELECT count(*) FROM operations_commerce_credentials
         WHERE organization_id = $1`,
        [fixture.targetScaffold.organizationId]), 0)
      assert.equal(await count(target,
        'SELECT count(*) FROM operations_orders WHERE organization_id = $1',
        [fixture.targetScaffold.organizationId]), 0)
      assert.equal(await count(target,
        `SELECT count(*) FROM operations_commerce_order_history_policies
         WHERE organization_id = $1`,
        [fixture.targetScaffold.organizationId]), 0)
    }

    const carrierFixture = fixtures[0]
    const carrierMigrationResult = mapping.results[0]
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_integration_accounts
       WHERE organization_id = $1 AND integration_type = 'carrier'`,
      [carrierFixture.targetScaffold.organizationId]), 2)
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_commerce_store_sync_controls
       WHERE organization_id = $1`,
      [carrierFixture.targetScaffold.organizationId]), 1)
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_carrier_account_migration_placeholders
       WHERE organization_id = $1 AND state = 'awaiting_credential_rebind'`,
      [carrierFixture.targetScaffold.organizationId]), 2)
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_carrier_credentials
       WHERE organization_id = $1`,
      [carrierFixture.targetScaffold.organizationId]), 0)
    assert.equal(await count(target,
      `SELECT count(*) FROM operations_carrier_accounts
       WHERE organization_id = $1`,
      [carrierFixture.targetScaffold.organizationId]), 0)
    const authorityBefore = (await target.query(
      `SELECT integration.status AS integration_status,
              credential.credential_fingerprint,
              carrier_account.account_number_fingerprint,
              carrier_account.registered_address_fingerprint
       FROM operations_integration_accounts integration
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = integration.organization_id
        AND credential.integration_account_id = integration.id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = integration.organization_id
        AND carrier_account.integration_account_id = integration.id
       WHERE integration.organization_id = $1::uuid AND integration.id = $2::uuid`,
      [carrierFixture.targetSourceAuthority.scaffold.organizationId,
        carrierFixture.targetSourceAuthority.account.id],
    )).rows[0]
    const directCarrier = await materializeTargetCarrier(
      target,
      carrierFixture,
      carrierMigrationResult,
      carrierFixture.carrierAccounts[0],
    )
    const managedCarrier = await materializeTargetCarrier(
      target,
      carrierFixture,
      carrierMigrationResult,
      carrierFixture.carrierAccounts[1],
    )
    assert.equal((await target.query(
      `SELECT operations_shopify_carrier_configuration_allows_rating(
                configuration, environment
              ) AS allowed
       FROM operations_integration_accounts WHERE id = $1::uuid`,
      [managedCarrier.integrationAccountId],
    )).rows[0].allowed, true)
    assert.equal((await target.query(
      `SELECT operations_shopify_carrier_configuration_allows_rating(
                configuration, environment
              ) AS allowed
       FROM operations_integration_accounts WHERE id = $1::uuid`,
      [directCarrier.integrationAccountId],
    )).rows[0].allowed, true)
    const authorityAfter = (await target.query(
      `SELECT integration.status AS integration_status,
              credential.credential_fingerprint,
              carrier_account.account_number_fingerprint,
              carrier_account.registered_address_fingerprint
       FROM operations_integration_accounts integration
       JOIN operations_carrier_credentials credential
         ON credential.organization_id = integration.organization_id
        AND credential.integration_account_id = integration.id
       JOIN operations_carrier_accounts carrier_account
         ON carrier_account.organization_id = integration.organization_id
        AND carrier_account.integration_account_id = integration.id
       WHERE integration.organization_id = $1::uuid AND integration.id = $2::uuid`,
      [carrierFixture.targetSourceAuthority.scaffold.organizationId,
        carrierFixture.targetSourceAuthority.account.id],
    )).rows[0]
    assert.deepEqual(authorityAfter, authorityBefore)
    await assert.rejects(
      target.query(
        `UPDATE operations_integration_accounts SET status = 'disabled'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [carrierFixture.targetSourceAuthority.scaffold.organizationId,
          carrierFixture.targetSourceAuthority.account.id],
      ),
      /source integration authority is immutable/iu,
    )
    await assert.rejects(
      target.query(
        `UPDATE operations_carrier_credentials
         SET verification_status = 'failed', verified_at = NULL
         WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
        [carrierFixture.targetSourceAuthority.scaffold.organizationId,
          carrierFixture.targetSourceAuthority.account.id],
      ),
      /source credential authority must remain verified/iu,
    )
    await assert.rejects(
      target.query(
        `UPDATE operations_carrier_accounts SET allow_sender_billing = false
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [carrierFixture.targetSourceAuthority.scaffold.organizationId,
          carrierFixture.targetSourceAuthority.account.carrierAccount.id],
      ),
      /source carrier authority is immutable/iu,
    )
    await assert.rejects(
      target.query(
        `UPDATE operations_carrier_accounts SET account_number_last_four = '9999'
         WHERE id = $1::uuid`,
        [managedCarrier.placeholderIdentity.id],
      ),
      /verified carrier shipper identity is immutable/iu,
    )

    const firstResult = mapping.results[0]
    const firstFixture = fixtures[0]
    const firstTargetAccountId = firstResult.mapping.operations_integration_accounts[
      firstFixture.domain.account.id
    ].id
    await assert.rejects(
      target.query(
        `UPDATE operations_commerce_migration_provider_identity_fences
         SET verification_state = 'verified',
             verified_external_account_id_sha256 = $3,
             verified_by = $4, verified_at = clock_timestamp()
         WHERE organization_id = $1 AND integration_account_id = $2`,
        [firstFixture.targetScaffold.organizationId, firstTargetAccountId,
          digest('wrong-provider'), CONFIRMED_OWNER_EMAIL],
      ),
      /provider identity did not match|verification_valid/iu,
    )
    await assert.rejects(
      target.query(
        `UPDATE operations_integration_accounts
         SET external_account_id = 'wrong-provider', status = 'active'
         WHERE id = $1`,
        [firstTargetAccountId],
      ),
      /provider identity is not verified/iu,
    )
    await assert.rejects(
      target.query(
        `UPDATE operations_integration_accounts SET provider = 'faire'
         WHERE id = $1`,
        [firstTargetAccountId],
      ),
      /provider, integration type, and environment are immutable/iu,
    )
    await target.query('BEGIN')
    try {
      await target.query(
        `UPDATE operations_commerce_migration_provider_identity_fences
         SET verification_state = 'verified',
             verified_external_account_id_sha256 = $3,
             verified_by = $4, verified_at = clock_timestamp()
         WHERE organization_id = $1 AND integration_account_id = $2`,
        [firstFixture.targetScaffold.organizationId, firstTargetAccountId,
          firstFixture.domain.account.externalAccountIdSha256,
          CONFIRMED_OWNER_EMAIL],
      )
      await target.query(
        `UPDATE operations_integration_accounts
         SET external_account_id = $2, status = 'active'
         WHERE id = $1`,
        [firstTargetAccountId, firstFixture.domain.externalAccountId],
      )
      await target.query(
        `UPDATE operations_external_identifiers
         SET status = 'active', last_verified_at = clock_timestamp(),
             match_evidence = match_evidence ||
               '{"migrationProviderIdentityVerified":true}'::jsonb
         WHERE organization_id = $1 AND integration_account_id = $2
           AND status = 'stale'
           AND match_evidence->>'migrationProviderIdentityFence' = 'true'`,
        [firstFixture.targetScaffold.organizationId, firstTargetAccountId],
      )
      await target.query('COMMIT')
    } catch (error) {
      await target.query('ROLLBACK')
      throw error
    }
    assert.equal((await target.query(
      `SELECT status FROM operations_external_identifiers
       WHERE organization_id = $1 AND integration_account_id = $2`,
      [firstFixture.targetScaffold.organizationId, firstTargetAccountId],
    )).rows[0].status, 'active')
    const secondFixture = fixtures[1]
    const secondTargetAccountId = mapping.results[1]
      .mapping.operations_integration_accounts[secondFixture.domain.account.id].id
    await assert.rejects(
      target.query(
        `UPDATE operations_commerce_migration_provider_identity_fences
         SET verification_state = 'verified',
             verified_external_account_id_sha256 = expected_external_account_id_sha256,
             verified_by = $3, verified_at = clock_timestamp()
         WHERE organization_id = $1 AND integration_account_id = $2`,
        [secondFixture.targetScaffold.organizationId, secondTargetAccountId,
          CONFIRMED_OWNER_EMAIL],
      ),
      /verification_valid|did not match|not eligible for reconnect/iu,
    )

    const retryMapping = join(directory, 'retry-mapping.json')
    const retry = await runMigration(
      applyArguments(planPath, plan.manifestDigest, retryMapping),
      environment,
      runtime,
    )
    assert.ok(retry.results.every((result) => result.disposition === 'already_applied'))
    assert.deepEqual(
      retry.results.map((result) => result.receiptIdentityDigest),
      mapping.results.map((result) => result.receiptIdentityDigest),
    )

    const recoveredMapping = join(directory, 'recovered-mapping.json')
    const recovered = await runMigration(
      exportArguments(planPath, plan.manifestDigest, recoveredMapping),
      environment,
      runtime,
    )
    assert.ok(recovered.results.every((result) => result.disposition === 'receipt_exported'))
    assert.deepEqual(
      recovered.results.map((result) => result.receiptIdentityDigest),
      mapping.results.map((result) => result.receiptIdentityDigest),
    )
    assertPrivateFile(recoveredMapping)

    const tamperedExternalId = 'external-customer-1-tampered'
    const tamperedIdentifier = await target.query(
      `UPDATE operations_external_identifiers
       SET external_id = $3
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_id = 'external-customer-1'
       RETURNING entity_global_id`,
      [firstFixture.targetScaffold.organizationId, firstTargetAccountId,
        tamperedExternalId],
    )
    assert.equal(tamperedIdentifier.rowCount, 1)
    const tamperedReceiptMapping = join(directory, 'tampered-receipt-mapping.json')
    await assert.rejects(
      runMigration(
        exportArguments(planPath, plan.manifestDigest, tamperedReceiptMapping),
        environment,
        runtime,
      ),
      /migration receipt materialized rows changed/u,
    )
    assert.equal(existsSync(tamperedReceiptMapping), false)
    assert.equal((await target.query(
      `UPDATE operations_external_identifiers
       SET external_id = 'external-customer-1'
       WHERE organization_id = $1::uuid
         AND integration_account_id = $2::uuid
         AND external_id = $3`,
      [firstFixture.targetScaffold.organizationId, firstTargetAccountId,
        tamperedExternalId],
    )).rowCount, 1)

    await assert.rejects(
      target.query(
        `UPDATE audit_events SET subject = 'changed'
         WHERE event_type = 'operations.commerce_workspace_migration.completed'`,
      ),
      /migration receipts are immutable/iu,
    )
    await assert.rejects(
      target.query(
        `DELETE FROM audit_events
         WHERE event_type = 'operations.commerce_workspace_migration.completed'`,
      ),
      /migration receipts are immutable/iu,
    )

    await source.query(
      `UPDATE crm_products SET description = description || ' drift'
       WHERE id = $1`,
      [fixtures[0].domain.productId],
    )
    const sourceDriftMapping = join(directory, 'source-drift-mapping.json')
    await assert.rejects(
      runMigration(
        applyArguments(planPath, plan.manifestDigest, sourceDriftMapping),
        environment,
        runtime,
      ),
      /source selection changed after the reviewed plan/u,
    )
    assert.equal(existsSync(sourceDriftMapping), false)

    const wrongEndpointPlan = join(directory, 'wrong-endpoint-plan.json')
    await assert.rejects(
      runMigration(
        planArguments(wrongEndpointPlan),
        { ...environment, TARGET_DATABASE_ENDPOINT_SHA256: digest('wrong-target') },
        runtime,
      ),
      /independently reviewed target endpoint binding/u,
    )
    assert.equal(existsSync(wrongEndpointPlan), false)
  } finally {
    await Promise.allSettled([source.end(), target.end()])
  }
}

async function run() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-commerce-migration-${process.pid}-${randomUUID().slice(0, 8)}`
  const directory = mkdtempSync(join(tmpdir(), 'clawpilot-commerce-migration-'))
  const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 6)}`
  const names = {
    template: `commerce_migration_template_${suffix}`,
    source: `commerce_migration_source_${suffix}`,
    target: `commerce_migration_target_${suffix}`,
  }
  const externalAdminUrl = String(
    process.env.CLAWPILOT_MIGRATION_TEST_POSTGRES_ADMIN_URL || '',
  ).trim()
  let ownsContainer = false
  let adminUrl
  chmodSync(directory, 0o700)
  try {
    if (externalAdminUrl) {
      adminUrl = externalAdminUrl
      await waitForPostgres(adminUrl)
    } else {
      command('docker', [
        'run', '--rm', '-d', '--name', container,
        '-e', 'POSTGRES_PASSWORD=commerce_migration',
        '-e', 'POSTGRES_DB=postgres',
        '-p', '127.0.0.1::5432',
        'pgvector/pgvector:pg16',
      ], { timeout: 180_000 })
      ownsContainer = true
      const portOutput = command('docker', ['port', container, '5432/tcp'])
      const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
      assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
      adminUrl = databaseUrl(port, 'postgres')
      await waitForPostgres(adminUrl)
    }
    const admin = new Pool({ connectionString: adminUrl, max: 1 })
    await admin.query(`CREATE DATABASE ${names.template}`)
    await admin.end()
    const templateUrl = withDatabase(adminUrl, names.template)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: templateUrl, PGSSLMODE: 'disable' },
      timeout: 300_000,
    })
    const templatePool = new Pool({ connectionString: templateUrl, max: 1 })
    await installCapabilityStubs(templatePool)
    await templatePool.end()
    const cloneAdmin = new Pool({ connectionString: adminUrl, max: 1 })
    await cloneAdmin.query(`CREATE DATABASE ${names.source} TEMPLATE ${names.template}`)
    await cloneAdmin.query(`CREATE DATABASE ${names.target} TEMPLATE ${names.template}`)
    await cloneAdmin.end()
    await runAcceptance(
      withDatabase(adminUrl, names.source),
      withDatabase(adminUrl, names.target),
      directory,
    )
  } finally {
    if (adminUrl) {
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 })
      for (const database of [names.source, names.target, names.template]) {
        await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
          .catch(() => undefined)
      }
      await cleanup.end().catch(() => undefined)
    }
    if (ownsContainer) {
      spawnSync('docker', ['stop', '-t', '1', container], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
      })
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

await run()
console.log('Commerce workspace migration disposable-PostgreSQL acceptance: PASS')
