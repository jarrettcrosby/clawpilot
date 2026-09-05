#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  createDecipheriv,
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  MANAGED_REBIND_MATERIAL_FORMAT,
  MIGRATION_MANIFEST_FORMAT,
  MIGRATION_MAPPING_FORMAT,
  MIGRATION_SCRIPT_VERSION,
  SOURCE_DATABASE_IDENTITY,
  TARGET_DATABASE_IDENTITY,
  applyRebind,
  applyValidatedMaterials,
  carrierAddressFingerprint,
  databaseEndpointFingerprint,
  digest,
  exportCommittedReceipt,
  main,
  managedRebindMaterialDigest,
  planRebind,
  sha256,
} from './rebind-migrated-production-integrations.mjs'

const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')
const actor = 'migration-test@example.com'
const sourceKey = 'source-provider-rebind-fixture-key-00000000000000000001'
const targetKey = 'target-provider-rebind-fixture-key-00000000000000000002'
const address = Object.freeze({
  line1: '101 Jegs Place',
  line2: null,
  city: 'Delaware',
  region: 'OH',
  postalCode: '43015',
  countryCode: 'US',
})

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

function derivedKey(secret) {
  return createHash('sha256').update(secret).digest()
}

function encrypt(value, key, aad) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', derivedKey(key), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()])
  return { ciphertext, iv, tag: cipher.getAuthTag() }
}

function decrypt(fields, key, aad) {
  const decipher = createDecipheriv('aes-256-gcm', derivedKey(key), fields.iv)
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(fields.tag)
  return Buffer.concat([decipher.update(fields.ciphertext), decipher.final()])
}

function commerceAad(org, provider, environment, externalId) {
  return `clawpilot:commerce:${org}:${provider}:${environment}:${externalId}:credential:v1`
}

function carrierCredentialAad(org, provider, environment) {
  return `clawpilot:carrier:${org}:${provider}:${environment}:credential:v1`
}

function carrierAccountAad(org, provider, environment, globalId) {
  return `clawpilot:carrier:${org}:${provider}:${environment}:account:${globalId}:v1`
}

function accountFingerprint(key, org, provider, environment, accountNumber) {
  const fingerprintKey = createHmac('sha256', derivedKey(key))
    .update('clawpilot:carrier:fingerprint:v1', 'utf8')
    .digest()
  return createHmac('sha256', fingerprintKey)
    .update(`${org}:${provider}:${environment}:${accountNumber}`, 'utf8')
    .digest('hex')
}

function receiptDigest(payload) {
  const copy = structuredClone(payload)
  delete copy.receiptIdentityDigest
  return digest(copy)
}

function reviewedPlanDigest(plan) {
  const copy = structuredClone(plan)
  delete copy.planDigest
  return digest(copy)
}

function rebindReceiptDigest(payload) {
  const copy = structuredClone(payload)
  delete copy.receiptDigest
  return digest(copy)
}

async function applyWithDedicatedClients(sourcePool, targetPool, input) {
  const source = await sourcePool.connect()
  const target = await targetPool.connect()
  try {
    return await applyRebind({ ...input, source, target })
  } finally {
    source.release()
    target.release()
  }
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    try {
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE workspace_organizations (id uuid PRIMARY KEY, reference_code text UNIQUE NOT NULL);
CREATE TABLE operations_integration_accounts (
  id uuid PRIMARY KEY, global_id text UNIQUE NOT NULL, organization_id uuid NOT NULL,
  provider text NOT NULL, integration_type text NOT NULL, environment text NOT NULL,
  display_name text NOT NULL, status text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}',
  credential_reference text, external_account_id text,
  commerce_credential_generation integer NOT NULL DEFAULT 0,
  receipt_intake_enabled boolean NOT NULL DEFAULT false,
  created_by text, updated_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, id), UNIQUE (organization_id, integration_type, provider, environment)
);
CREATE TABLE operations_commerce_credentials (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  external_account_id text NOT NULL, auth_mode text NOT NULL,
  credential_ciphertext bytea NOT NULL, credential_iv bytea NOT NULL, credential_tag bytea NOT NULL,
  credential_version integer NOT NULL, credential_identifier_last_four text NOT NULL,
  verification_status text NOT NULL, verified_at timestamptz, last_error_code text,
  webhook_verification_status text NOT NULL, webhook_verified_at timestamptz,
  created_by text, updated_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE operations_commerce_order_history_policies (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  provider text NOT NULL, history_mode text NOT NULL,
  ingestion_floor timestamptz, frozen_at timestamptz NOT NULL,
  configured_by text, created_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE operations_carrier_credentials (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  credential_ciphertext bytea NOT NULL, credential_iv bytea NOT NULL, credential_tag bytea NOT NULL,
  credential_version integer NOT NULL, client_id_last_four text NOT NULL,
  account_number_last_four text, verification_status text NOT NULL,
  verified_at timestamptz, last_error_code text, created_by text, updated_by text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE operations_carrier_accounts (
  id uuid PRIMARY KEY, global_id text UNIQUE NOT NULL, organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL, display_name text NOT NULL, sender_name text NOT NULL,
  account_number_ciphertext text NOT NULL, account_number_iv text NOT NULL,
  account_number_tag text NOT NULL, encryption_version integer NOT NULL,
  account_number_last_four text NOT NULL, account_number_fingerprint text NOT NULL,
  registered_address jsonb NOT NULL, registered_address_fingerprint text NOT NULL,
  address_verification text NOT NULL, allow_sender_billing boolean NOT NULL,
  allow_recipient_billing boolean NOT NULL, allow_third_party_billing boolean NOT NULL,
  status text NOT NULL, created_by text, updated_by text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, integration_account_id, id), UNIQUE (organization_id, id)
);
CREATE TABLE operations_warehouses (
  id uuid PRIMARY KEY, global_id text UNIQUE NOT NULL, organization_id uuid NOT NULL,
  address jsonb NOT NULL, status text NOT NULL
);
CREATE TABLE operations_carrier_account_migration_placeholders (
  id uuid PRIMARY KEY, global_id text UNIQUE NOT NULL, organization_id uuid NOT NULL,
  integration_account_id uuid NOT NULL, provider text NOT NULL, environment text NOT NULL,
  display_name text NOT NULL, sender_name text NOT NULL,
  source_carrier_account_id uuid NOT NULL, source_carrier_account_global_id text NOT NULL,
  source_account_number_last_four text NOT NULL, source_account_number_fingerprint text NOT NULL,
  source_registered_address_fingerprint text NOT NULL, rebind_mode text NOT NULL,
  required_source_authority_organization_id uuid,
  required_source_authority_integration_account_id uuid,
  required_source_authority_carrier_account_id uuid,
  required_source_organization_reference text,
  required_source_integration_global_id text,
  required_source_carrier_account_global_id text,
  state text NOT NULL, target_account_number_fingerprint text,
  materialized_by text, materialized_at timestamptz,
  created_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (organization_id, integration_account_id)
);
CREATE TABLE operations_commerce_migration_provider_identity_fences (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  provider text NOT NULL, integration_type text NOT NULL, identity_kind text NOT NULL,
  environment text NOT NULL, source_database_identity uuid NOT NULL,
  source_database_endpoint_sha256 text NOT NULL, target_database_endpoint_sha256 text NOT NULL,
  source_account_global_id text NOT NULL, source_provider_identity_sha256 text NOT NULL,
  expected_external_account_id_sha256 text, reconnect_eligible boolean NOT NULL,
  verification_state text NOT NULL, verified_external_account_id_sha256 text,
  verified_carrier_account_id uuid, verified_carrier_account_identity_sha256 text,
  verified_by text, verified_at timestamptz, migration_event_key text NOT NULL,
  created_by text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE operations_commerce_store_sync_controls (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  desired_state text NOT NULL, explicit_choice boolean NOT NULL, revision bigint NOT NULL,
  reason text NOT NULL, created_by text, updated_by text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE operations_commerce_sync_cursors (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL, resource text NOT NULL,
  provider_cursor text, high_watermark timestamptz, reconciliation_status text NOT NULL,
  records_seen bigint NOT NULL, records_applied bigint NOT NULL, records_held bigint NOT NULL,
  consecutive_failures integer NOT NULL, last_error_code text,
  last_started_at timestamptz, last_completed_at timestamptz, updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (organization_id, integration_account_id, resource)
);
CREATE TABLE operations_shopify_fulfillment_notification_policies (
  organization_id uuid NOT NULL, integration_account_id uuid NOT NULL,
  policy_version text NOT NULL, notify_customer_default boolean NOT NULL,
  revision integer NOT NULL, change_reason text NOT NULL, created_by text, updated_by text,
  PRIMARY KEY (organization_id, integration_account_id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text, event_type text NOT NULL,
  aggregate_type text, aggregate_id text, payload jsonb NOT NULL DEFAULT '{}',
  event_key text, subject text, organization_id uuid, is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX audit_events_event_key_fixture ON audit_events(event_key) WHERE event_key IS NOT NULL;
CREATE TABLE fixture_fail_activation (enabled boolean NOT NULL DEFAULT false);
INSERT INTO fixture_fail_activation VALUES (false);

CREATE FUNCTION fixture_guard_placeholder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'materialized' THEN
    IF NOT EXISTS (
      SELECT 1 FROM operations_carrier_accounts carrier
      JOIN operations_carrier_credentials credential
        ON credential.organization_id = carrier.organization_id
       AND credential.integration_account_id = carrier.integration_account_id
      JOIN operations_integration_accounts account
        ON account.organization_id = carrier.organization_id
       AND account.id = carrier.integration_account_id
      WHERE carrier.organization_id = NEW.organization_id AND carrier.id = NEW.id
        AND carrier.account_number_fingerprint = NEW.target_account_number_fingerprint
        AND credential.verification_status = 'verified' AND account.status <> 'active'
    ) THEN RAISE EXCEPTION 'fixture materialization order violated'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixture_guard_placeholder_update BEFORE UPDATE
ON operations_carrier_account_migration_placeholders
FOR EACH ROW EXECUTE FUNCTION fixture_guard_placeholder();

CREATE FUNCTION fixture_guard_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_state = 'verified' AND NEW.integration_type = 'carrier' THEN
    IF NOT EXISTS (
      SELECT 1 FROM operations_carrier_account_migration_placeholders
      WHERE organization_id = NEW.organization_id
        AND integration_account_id = NEW.integration_account_id
        AND state = 'materialized'
        AND id = NEW.verified_carrier_account_id
        AND target_account_number_fingerprint = NEW.verified_carrier_account_identity_sha256
    ) THEN RAISE EXCEPTION 'fixture carrier fence order violated'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixture_guard_fence_update BEFORE UPDATE
ON operations_commerce_migration_provider_identity_fences
FOR EACH ROW EXECUTE FUNCTION fixture_guard_fence();

CREATE FUNCTION fixture_guard_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fence_state text; placeholder_state text;
BEGIN
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN
    IF (SELECT enabled FROM fixture_fail_activation LIMIT 1) AND NEW.provider = 'ups_rest' THEN
      RAISE EXCEPTION 'fixture requested rollback';
    END IF;
    SELECT verification_state INTO fence_state
    FROM operations_commerce_migration_provider_identity_fences
    WHERE organization_id = NEW.organization_id AND integration_account_id = NEW.id;
    IF fence_state <> 'verified' THEN RAISE EXCEPTION 'fixture provider fence order violated'; END IF;
    IF NEW.integration_type = 'carrier' THEN
      SELECT state INTO placeholder_state
      FROM operations_carrier_account_migration_placeholders
      WHERE organization_id = NEW.organization_id AND integration_account_id = NEW.id;
      IF placeholder_state <> 'materialized' THEN RAISE EXCEPTION 'fixture carrier activation order violated'; END IF;
      IF NEW.configuration->>'managedBy' = 'ag-alchemy-episcs-sandbox-rating-delegation' THEN
        IF NEW.configuration->'migrationSourceAuthorityVerified' <> 'true'::jsonb
           OR NEW.configuration->>'delegatedFromOrganizationReferenceCode' <> 'ga5122758'
           OR NEW.configuration->>'sourceIntegrationGlobalId' <> 'gia7335302'
           OR NEW.configuration->>'sourceCarrierAccountGlobalId' <> 'gac2368052'
           OR NEW.configuration->>'senderOriginWarehouseGlobalId' <> 'gwh1234567'
        THEN RAISE EXCEPTION 'fixture managed delegation binding violated'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixture_guard_activation_update BEFORE UPDATE
ON operations_integration_accounts
FOR EACH ROW EXECUTE FUNCTION fixture_guard_activation();
`

function fixture() {
  const sourceOrg = randomUUID()
  const targetOrg = randomUUID()
  const authorityOrg = randomUUID()
  const externalId = 'gid://shopify/Shop/987654321'
  const directNumber = 'UPS-TEST-1234'
  const authorityNumber = 'FEDEX-TEST-1073'
  const directFingerprint = accountFingerprint(
    sourceKey, sourceOrg, 'ups_rest', 'production', directNumber,
  )
  const addressFingerprint = carrierAddressFingerprint(address)
  const accounts = {
    commerce: {
      sourceId: randomUUID(), sourceGlobalId: 'gia1000001', provider: 'shopify',
      integrationType: 'commerce', environment: 'production',
      externalAccountIdSha256: sha256(externalId),
      targetId: randomUUID(), targetGlobalId: 'gia2000001', externalId,
    },
    direct: {
      sourceId: randomUUID(), sourceGlobalId: 'gia1000002',
      sourceCarrierAccountId: randomUUID(), sourceCarrierAccountGlobalId: 'gac1000002',
      provider: 'ups_rest', integrationType: 'carrier', environment: 'production',
      rebindMode: 'direct_credential', sourceAccountNumberFingerprint: directFingerprint,
      sourceAddressFingerprint: addressFingerprint,
      targetId: randomUUID(), targetGlobalId: 'gia2000002',
      targetCarrierId: randomUUID(), targetCarrierGlobalId: 'gac2000002', directNumber,
    },
    authority: {
      sourceId: randomUUID(), sourceGlobalId: 'gia1000003',
      sourceCarrierAccountId: randomUUID(), sourceCarrierAccountGlobalId: 'gac1000003',
      provider: 'fedex_rest', integrationType: 'carrier', environment: 'sandbox',
      rebindMode: 'source_authority', authorityIntegrationGlobalId: 'gia7335302',
      authorityCarrierAccountGlobalId: 'gac2368052', expectedLastFour: '1073',
      expectedAddressLine1: '101 Jegs Place', targetId: randomUUID(),
      targetGlobalId: 'gia2000003', targetCarrierId: randomUUID(),
      targetCarrierGlobalId: 'gac2000003', authorityNumber,
      authorityIntegrationId: randomUUID(), authorityCarrierId: randomUUID(),
    },
  }
  return {
    sourceOrg, targetOrg, authorityOrg, accounts,
    workspace: {
      key: 'fixture-workspace',
      sourceOrganizationId: sourceOrg,
      sourceOrganizationReference: 'ga1000001',
      targetOrganizationId: targetOrg,
      targetOrganizationReference: 'ga2000001',
      accounts: [accounts.commerce, accounts.direct, accounts.authority].map((account) => {
        const copy = { ...account }
        for (const key of [
          'targetId', 'targetGlobalId', 'targetCarrierId', 'targetCarrierGlobalId',
          'externalId', 'directNumber', 'authorityNumber', 'authorityIntegrationId',
          'authorityCarrierId',
        ]) delete copy[key]
        return Object.freeze(copy)
      }),
    },
  }
}

async function seedSource(client, data) {
  const { sourceOrg, accounts } = data
  await client.query('INSERT INTO app_settings VALUES ($1, $2::jsonb)', [
    'deployment.database.identity', JSON.stringify({ id: SOURCE_DATABASE_IDENTITY }),
  ])
  const commerceCredential = encrypt(JSON.stringify({
    provider: 'shopify', authMode: 'shopify_client_credentials',
    clientId: 'fixture-shopify-client', clientSecret: 'fixture-shopify-client-secret',
  }), sourceKey, commerceAad(sourceOrg, 'shopify', 'production', accounts.commerce.externalId))
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, receipt_intake_enabled, created_by, updated_by
     ) VALUES ($1,$2,$3,'shopify','commerce','production','Fixture Shopify','active',$4::jsonb,$5,1,true,$6,$6)`,
    [accounts.commerce.sourceId, accounts.commerce.sourceGlobalId, sourceOrg,
      JSON.stringify({ shopDomain: 'fixture-shop.myshopify.com' }), accounts.commerce.externalId, actor],
  )
  await client.query(
    `INSERT INTO operations_commerce_credentials VALUES (
       $1,$2,$3,'shopify_client_credentials',$4,$5,$6,1,'ient','verified',now(),NULL,
       'verified',now(),$7,$7,now(),now())`,
    [sourceOrg, accounts.commerce.sourceId, accounts.commerce.externalId,
      commerceCredential.ciphertext, commerceCredential.iv, commerceCredential.tag, actor],
  )
  const credentialValue = { clientId: 'fixture-ups-client-1234', clientSecret: 'fixture-ups-secret', accountNumber: null }
  const credential = encrypt(
    JSON.stringify(credentialValue), sourceKey,
    carrierCredentialAad(sourceOrg, 'ups_rest', 'production'),
  )
  const account = encrypt(
    accounts.direct.directNumber, sourceKey,
    carrierAccountAad(sourceOrg, 'ups_rest', 'production', accounts.direct.sourceCarrierAccountGlobalId),
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id,global_id,organization_id,provider,integration_type,environment,display_name,status,
       configuration,created_by,updated_by
     ) VALUES ($1,$2,$3,'ups_rest','carrier','production','Fixture UPS','active','{}',$4,$4)`,
    [accounts.direct.sourceId, accounts.direct.sourceGlobalId, sourceOrg, actor],
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials VALUES (
       $1,$2,$3,$4,$5,1,'1234','1234','verified',now(),NULL,$6,$6,now(),now())`,
    [sourceOrg, accounts.direct.sourceId, credential.ciphertext, credential.iv, credential.tag, actor],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts VALUES (
       $1,$2,$3,$4,'Fixture UPS','Fixture Sender',$5,$6,$7,1,'1234',$8,$9::jsonb,$10,
       'provider_verified',true,true,true,'active',$11,$11,now(),now())`,
    [accounts.direct.sourceCarrierAccountId, accounts.direct.sourceCarrierAccountGlobalId,
      sourceOrg, accounts.direct.sourceId, account.ciphertext.toString('base64'),
      account.iv.toString('base64'), account.tag.toString('base64'),
      accounts.direct.sourceAccountNumberFingerprint, JSON.stringify(address),
      accounts.direct.sourceAddressFingerprint, actor],
  )
}

async function seedTarget(client, data, bindings) {
  const { targetOrg, authorityOrg, accounts } = data
  await client.query('INSERT INTO app_settings VALUES ($1, $2::jsonb)', [
    'deployment.database.identity', JSON.stringify({ id: TARGET_DATABASE_IDENTITY }),
  ])
  await client.query(
    `INSERT INTO workspace_organizations VALUES ($1,'ga2000001'),($2,'ga5122758')`,
    [targetOrg, authorityOrg],
  )
  const authorityCredentialValue = {
    clientId: 'fixture-fedex-client-1073', clientSecret: 'fixture-fedex-secret', accountNumber: null,
  }
  const authorityCredential = encrypt(
    JSON.stringify(authorityCredentialValue), targetKey,
    carrierCredentialAad(authorityOrg, 'fedex_rest', 'sandbox'),
  )
  const authorityAccount = encrypt(
    accounts.authority.authorityNumber, targetKey,
    carrierAccountAad(authorityOrg, 'fedex_rest', 'sandbox', 'gac2368052'),
  )
  const authorityFingerprint = accountFingerprint(
    targetKey, authorityOrg, 'fedex_rest', 'sandbox', accounts.authority.authorityNumber,
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id,global_id,organization_id,provider,integration_type,environment,display_name,status,
       configuration,credential_reference,created_by,updated_by
     ) VALUES ($1,'gia7335302',$2,'fedex_rest','carrier','sandbox','Authority FedEx','active','{}','authority',$3,$3)`,
    [accounts.authority.authorityIntegrationId, authorityOrg, actor],
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials VALUES (
       $1,$2,$3,$4,$5,1,'1073','1073','verified',now(),NULL,$6,$6,now(),now())`,
    [authorityOrg, accounts.authority.authorityIntegrationId,
      authorityCredential.ciphertext, authorityCredential.iv, authorityCredential.tag, actor],
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts VALUES (
       $1,'gac2368052',$2,$3,'Authority FedEx','Authority Sender',$4,$5,$6,1,'1073',$7,$8::jsonb,$9,
       'provider_verified',true,true,true,'active',$10,$10,now(),now())`,
    [accounts.authority.authorityCarrierId, authorityOrg, accounts.authority.authorityIntegrationId,
      authorityAccount.ciphertext.toString('base64'), authorityAccount.iv.toString('base64'),
      authorityAccount.tag.toString('base64'), authorityFingerprint, JSON.stringify(address),
      carrierAddressFingerprint(address), actor],
  )
  await client.query(
    `INSERT INTO operations_warehouses VALUES ($1,'gwh1234567',$2,$3::jsonb,'active')`,
    [randomUUID(), targetOrg, JSON.stringify(address)],
  )
  for (const account of Object.values(accounts)) {
    const config = {
      migrationRequiresCredentialRebind: true,
      migrationRequiresProviderIdentityVerification: true,
    }
    if (account === accounts.direct) {
      config.rebindRequestedCapabilities = ['production_rate']
      config.allowedCapabilities = []
    }
    if (account === accounts.authority) {
      Object.assign(config, {
        migrationRequiresSourceAuthorityRebind: true,
        rebindRequestedCapabilities: ['sandbox_rate'],
        allowedCapabilities: [],
        managedBy: 'ag-alchemy-episcs-sandbox-rating-delegation',
        authorizationScope: 'sandbox_rating_only',
        credentialRevealAllowed: false,
        delegatedFromOrganizationReferenceCode: 'ga5122758',
        sourceIntegrationGlobalId: 'gia7335302',
        sourceCarrierAccountGlobalId: 'gac2368052',
        senderOriginWarehouseGlobalId: 'gwh1234567',
      })
    }
    await client.query(
      `INSERT INTO operations_integration_accounts (
         id,global_id,organization_id,provider,integration_type,environment,display_name,status,
         configuration,external_account_id,credential_reference,commerce_credential_generation,
         receipt_intake_enabled,created_by,updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'disabled',$8::jsonb,NULL,NULL,0,false,$9,$9)`,
      [account.targetId, account.targetGlobalId, targetOrg, account.provider,
        account.integrationType, account.environment, `Target ${account.provider}`,
        JSON.stringify(config), actor],
    )
    const providerIdentity = account.integrationType === 'commerce'
      ? account.externalAccountIdSha256
      : digest({ fixture: account.sourceGlobalId })
    await client.query(
      `INSERT INTO operations_commerce_migration_provider_identity_fences (
         organization_id,integration_account_id,provider,integration_type,identity_kind,environment,
         source_database_identity,source_database_endpoint_sha256,target_database_endpoint_sha256,
         source_account_global_id,source_provider_identity_sha256,expected_external_account_id_sha256,
         reconnect_eligible,verification_state,migration_event_key,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'awaiting_provider_identity',$13,$14)`,
      [targetOrg, account.targetId, account.provider, account.integrationType,
        account.integrationType === 'commerce' ? 'external_account_id' : 'carrier_shipper_account',
        account.environment, SOURCE_DATABASE_IDENTITY, bindings.source, bindings.target,
        account.sourceGlobalId, providerIdentity,
        account.integrationType === 'commerce' ? account.externalAccountIdSha256 : null,
        `fixture-migration:${account.sourceGlobalId}`, actor],
    )
    if (account.integrationType === 'commerce') {
      await client.query(
        `INSERT INTO operations_commerce_store_sync_controls VALUES (
           $1,$2,'paused',true,1,'Awaiting provider rebind',$3,$3,now(),now())`,
        [targetOrg, account.targetId, actor],
      )
      continue
    }
    const isAuthority = account === accounts.authority
    await client.query(
      `INSERT INTO operations_carrier_account_migration_placeholders (
         id,global_id,organization_id,integration_account_id,provider,environment,
         display_name,sender_name,source_carrier_account_id,source_carrier_account_global_id,
         source_account_number_last_four,source_account_number_fingerprint,
         source_registered_address_fingerprint,rebind_mode,
         required_source_authority_organization_id,required_source_authority_integration_account_id,
         required_source_authority_carrier_account_id,required_source_organization_reference,
         required_source_integration_global_id,required_source_carrier_account_global_id,
         state,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 $15,$16,$17,$18,$19,$20,'awaiting_credential_rebind',$21)`,
      [account.targetCarrierId, account.targetCarrierGlobalId, targetOrg, account.targetId,
        account.provider, account.environment, `Target ${account.provider}`, 'Fixture Sender',
        account.sourceCarrierAccountId, account.sourceCarrierAccountGlobalId,
        isAuthority ? '1073' : '1234',
        isAuthority ? digest({ source: 'authority-child' }) : account.sourceAccountNumberFingerprint,
        carrierAddressFingerprint(address), account.rebindMode,
        isAuthority ? authorityOrg : null,
        isAuthority ? accounts.authority.authorityIntegrationId : null,
        isAuthority ? accounts.authority.authorityCarrierId : null,
        isAuthority ? 'ga5122758' : null, isAuthority ? 'gia7335302' : null,
        isAuthority ? 'gac2368052' : null, actor],
    )
  }
}

function artifacts(data, bindings) {
  const workspace = data.workspace
  const planWorkspace = {
    key: workspace.key,
    source: {
      organizationId: workspace.sourceOrganizationId,
      organizationReference: workspace.sourceOrganizationReference,
    },
    target: {
      organizationId: workspace.targetOrganizationId,
      organizationReference: workspace.targetOrganizationReference,
    },
    accounts: workspace.accounts.map((account) => ({
      sourceId: account.sourceId,
      sourceGlobalId: account.sourceGlobalId,
      provider: account.provider,
      integrationType: account.integrationType,
      environment: account.environment,
      reconnectEligible: true,
      ...(account.integrationType === 'commerce'
        ? { externalAccountIdSha256: account.externalAccountIdSha256 }
        : { carrierAccount: {
            sourceId: account.sourceCarrierAccountId,
            sourceGlobalId: account.sourceCarrierAccountGlobalId,
            rebindMode: account.rebindMode,
          } }),
    })),
    ready: true,
  }
  const manifest = {
    format: MIGRATION_MANIFEST_FORMAT,
    scriptVersion: MIGRATION_SCRIPT_VERSION,
    createdAt: '2026-09-04T12:00:00.000Z',
    actor,
    sourceDatabase: { database_identity: SOURCE_DATABASE_IDENTITY, endpoint_sha256: bindings.source },
    targetDatabase: { database_identity: TARGET_DATABASE_IDENTITY, endpoint_sha256: bindings.target },
    workspaces: [planWorkspace],
    applyReady: true,
  }
  manifest.manifestDigest = digest(manifest)
  const mappingValue = {
    operations_integration_accounts: Object.fromEntries(Object.values(data.accounts).map((account) => [
      account.sourceId, { id: account.targetId, reference: account.targetGlobalId },
    ])),
    operations_carrier_account_migration_placeholders: Object.fromEntries(
      [data.accounts.direct, data.accounts.authority].map((account) => [
        account.sourceCarrierAccountId,
        { id: account.targetCarrierId, reference: account.targetCarrierGlobalId },
      ]),
    ),
  }
  const result = { key: workspace.key, disposition: 'created', mapping: mappingValue }
  const mapping = {
    format: MIGRATION_MAPPING_FORMAT,
    scriptVersion: MIGRATION_SCRIPT_VERSION,
    manifestDigest: manifest.manifestDigest,
    exportedAt: '2026-09-04T12:01:00.000Z',
    sourceDatabaseIdentity: SOURCE_DATABASE_IDENTITY,
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    sourceEndpointSha256: bindings.source,
    targetEndpointSha256: bindings.target,
    results: [result],
  }
  const payload = {
    scriptVersion: MIGRATION_SCRIPT_VERSION,
    manifestDigest: manifest.manifestDigest,
    source: { databaseIdentity: SOURCE_DATABASE_IDENTITY, endpointSha256: bindings.source },
    target: { databaseIdentity: TARGET_DATABASE_IDENTITY, endpointSha256: bindings.target },
    mapping: mappingValue,
    providerIdentityFenceDigest: digest({ fixture: 'fences' }),
    sourceAuthorityDependencies: [],
    sourceAuthorityDependencyDigest: digest([]),
    providerConnectionsCreated: 0,
    credentialRowsCopied: 0,
    carrierAccountSecretRowsCopied: 0,
  }
  payload.receiptIdentityDigest = receiptDigest(payload)
  result.receiptIdentityDigest = payload.receiptIdentityDigest
  return { manifest, mapping, payload }
}

function managedMaterial(data, artifact, bindings) {
  const material = {
    format: MANAGED_REBIND_MATERIAL_FORMAT,
    actor,
    migrationManifestDigest: artifact.manifest.manifestDigest,
    migrationMappingDigest: digest(artifact.mapping),
    targetDatabaseIdentity: TARGET_DATABASE_IDENTITY,
    targetDatabaseEndpointSha256: bindings.target,
    targetOrganizationId: data.targetOrg,
    targetIntegrationAccountId: data.accounts.authority.targetId,
    targetIntegrationAccountGlobalId: data.accounts.authority.targetGlobalId,
    targetCarrierAccountId: data.accounts.authority.targetCarrierId,
    targetCarrierAccountGlobalId: data.accounts.authority.targetCarrierGlobalId,
    sourceAccountGlobalId: data.accounts.authority.sourceGlobalId,
    provider: 'fedex_rest',
    environment: 'sandbox',
    authority: {
      organizationReference: 'ga5122758',
      integrationGlobalId: 'gia7335302',
      carrierAccountGlobalId: 'gac2368052',
    },
    approved: true,
    credential: {
      clientId: 'fresh-target-fedex-client-9088',
      clientSecret: 'fresh-target-fedex-secret',
    },
    accountNumber: data.accounts.authority.authorityNumber,
  }
  material.materialDigest = managedRebindMaterialDigest(material)
  return material
}

function fakeVerifier(data) {
  return {
    async commerce(account, credential, _configuration, targetGlobalId) {
      assert.equal(credential.clientSecret, 'fixture-shopify-client-secret')
      return {
        externalAccountId: data.accounts.commerce.externalId,
        identitySha256: sha256(data.accounts.commerce.externalId),
        accountName: 'Fixture shop',
        shopDomain: 'fixture-shop.myshopify.com',
        grantedScopes: ['read_orders', 'read_products'],
        desiredUri: `https://aiapp.eigenracing.com/api/integrations/commerce/shopify/webhooks/${targetGlobalId}`,
        webhooks: { ready: true, actions: [], observed: [] },
        runtime: { fake: true },
        operationalProbe: 'identity_scopes_webhooks_read_only',
        providerMutationCount: 0,
      }
    },
    async carrier(account, credential, accountNumber, registeredAddress) {
      assert.ok(['ups_rest', 'fedex_rest'].includes(account.provider))
      if (account.rebindMode === 'source_authority') {
        assert.equal(credential.clientId, 'fresh-target-fedex-client-9088')
        assert.match(credential.clientSecret, /^fresh-target-fedex-secret/u)
      } else {
        assert.equal(credential.clientId, 'fixture-ups-client-1234')
        assert.equal(credential.clientSecret, 'fixture-ups-secret')
      }
      return {
        credentialIdentitySha256: digest({ provider: account.provider, fixture: true }),
        clientIdLastFour: credential.clientId.slice(-4),
        accountNumberLastFour: accountNumber.slice(-4),
        addressFingerprint: carrierAddressFingerprint(registeredAddress),
        operationalProbe: 'rate_read_only',
        providerMutationCount: 0,
      }
    },
    async reconcileShopify(verification, expectedActions) {
      assert.deepEqual(expectedActions, [])
      return verification.webhooks
    },
  }
}

async function runAcceptance(sourceUrl, targetUrl) {
  const source = new Pool({ connectionString: sourceUrl, max: 2 })
  const target = new Pool({ connectionString: targetUrl, max: 2 })
  const data = fixture()
  const bindings = {
    source: databaseEndpointFingerprint(sourceUrl),
    target: databaseEndpointFingerprint(targetUrl),
  }
  try {
    await source.query(schema)
    await target.query(schema)
    await seedSource(source, data)
    await seedTarget(target, data, bindings)
    const artifact = artifacts(data, bindings)
    await target.query(
      `INSERT INTO audit_events (
         actor,event_type,aggregate_type,aggregate_id,payload,event_key,subject,organization_id,is_system
       ) VALUES ($1,'operations.commerce_workspace_migration.completed','workspace_organization',
                 $2::uuid::text,$3::jsonb,$4,$1,$2::uuid,false)`,
      [actor, data.targetOrg, JSON.stringify(artifact.payload), 'fixture-migration-receipt'],
    )
    const baseInput = {
      actor, source, target, sourceKey, targetKey, bindings,
      manifest: artifact.manifest, mapping: artifact.mapping,
      workspaces: [data.workspace], verifier: fakeVerifier(data),
    }
    const inputFor = (account, extra = {}) => ({
      ...baseInput,
      selectedAccountGlobalId: account.sourceGlobalId,
      ...extra,
    })
    await assert.rejects(
      planRebind(inputFor(data.accounts.direct)),
      /lacks the immutable provider rebind receipt guard/u,
    )
    await target.query(readFileSync(
      new URL(
        '../db/migrations/0355_operations_migrated_provider_rebind_receipt_immutability.sql',
        import.meta.url,
      ),
      'utf8',
    ))
    await assert.rejects(
      planRebind({ ...baseInput, selectedAccountGlobalId: 'gia9999999' }),
      /Exactly one compiled source provider Global ID must be selected/u,
    )

    const directInput = inputFor(data.accounts.direct)
    await source.query(
      `UPDATE operations_carrier_accounts SET allow_sender_billing = false
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.sourceOrg, data.accounts.direct.sourceId],
    )
    await assert.rejects(planRebind(directInput), /direct carrier identity changed/u)
    await source.query(
      `UPDATE operations_carrier_accounts
       SET allow_sender_billing = true, address_verification = 'unverified'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.sourceOrg, data.accounts.direct.sourceId],
    )
    await assert.rejects(planRebind(directInput), /direct carrier identity changed/u)
    await source.query(
      `UPDATE operations_carrier_accounts SET address_verification = 'operator_attested'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.sourceOrg, data.accounts.direct.sourceId],
    )
    const directPlan = await planRebind(directInput)
    assert.equal(directPlan.plan.providers.length, 1)
    assert.equal(directPlan.plan.transaction.providerCount, 1)
    assert.equal(directPlan.plan.selectedSourceAccountGlobalId, data.accounts.direct.sourceGlobalId)
    assert.equal(directPlan.plan.providers[0].credentialValidation, 'verified_read_only')
    assert.equal(JSON.stringify(directPlan.plan).includes(data.accounts.direct.directNumber), false)
    await assert.rejects(
      applyValidatedMaterials(
        directInput,
        [directPlan.materials[0], directPlan.materials[0]],
        directPlan.plan,
      ),
      /Exactly one reviewed provider material may be applied/u,
    )

    await target.query('UPDATE fixture_fail_activation SET enabled = true')
    await assert.rejects(
      applyWithDedicatedClients(source, target, {
        ...directInput,
        plan: directPlan.plan,
        confirmDigest: directPlan.plan.planDigest,
      }),
      /fixture requested rollback/u,
    )
    const rolledBack = await target.query(
      `SELECT
         (SELECT count(*)::integer FROM operations_commerce_credentials) AS commerce,
         (SELECT count(*)::integer FROM operations_carrier_credentials
           WHERE organization_id = $1::uuid) AS carrier_credentials,
         (SELECT count(*)::integer FROM operations_carrier_accounts
           WHERE organization_id = $1::uuid) AS carrier_accounts,
         (SELECT count(*)::integer FROM operations_commerce_migration_provider_identity_fences
           WHERE organization_id = $1::uuid AND verification_state = 'verified') AS verified`,
      [data.targetOrg],
    )
    assert.deepEqual(rolledBack.rows[0], {
      commerce: 0, carrier_credentials: 0, carrier_accounts: 0, verified: 0,
    })

    await target.query('UPDATE fixture_fail_activation SET enabled = false')
    const directReceipt = await applyWithDedicatedClients(source, target, {
      ...directInput,
      plan: directPlan.plan,
      confirmDigest: directPlan.plan.planDigest,
    })
    assert.equal(directReceipt.status, 'committed')
    assert.equal(directReceipt.receipts.length, 1)
    assert.equal(directReceipt.providerWrites, 0)
    assert.equal(JSON.stringify(directReceipt).includes(data.accounts.direct.directNumber), false)
    const directAddressEvidence = await target.query(
      `SELECT address_verification, allow_sender_billing
       FROM operations_carrier_accounts
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.direct.targetId],
    )
    assert.deepEqual(directAddressEvidence.rows[0], {
      address_verification: 'operator_attested',
      allow_sender_billing: true,
    })
    const recoveredReceipt = await exportCommittedReceipt({
      ...directInput,
      plan: directPlan.plan,
      confirmDigest: directPlan.plan.planDigest,
    })
    assert.deepEqual(recoveredReceipt, directReceipt)
    const recoveryDirectory = mkdtempSync(path.join(tmpdir(), 'clawpilot-rebind-recovery-'))
    try {
      const recoveryPath = path.join(recoveryDirectory, 'receipt.json')
      let recoveryPoolCreations = 0
      const recoveredWithoutSource = await main({
        args: {
          command: 'export-receipt',
          actor,
          selectedAccountGlobalId: data.accounts.direct.sourceGlobalId,
          receiptOutput: recoveryPath,
          confirmDigest: directPlan.plan.planDigest,
        },
        environment: {
          TARGET_RAILWAY_PROJECT_ID: 'b5169ebd-8166-4b96-9a81-7cc8adaa9270',
          TARGET_RAILWAY_ENVIRONMENT_ID: '058ce52f-1d3b-44bb-afe2-0df2bf24efb9',
          TARGET_RAILWAY_ENVIRONMENT_NAME: 'production',
          TARGET_DATABASE_URL: targetUrl,
          TARGET_DATABASE_ENDPOINT_SHA256: bindings.target,
          PGSSLMODE: 'disable',
        },
        manifest: artifact.manifest,
        mapping: artifact.mapping,
        plan: directPlan.plan,
        workspaces: [data.workspace],
        allowTestBoundary: true,
        poolFactory(connectionString) {
          recoveryPoolCreations += 1
          assert.equal(connectionString, targetUrl)
          return new Pool({ connectionString, max: 1 })
        },
      })
      assert.equal(recoveryPoolCreations, 1)
      assert.equal(recoveredWithoutSource.command, 'export-receipt')
      assert.deepEqual(JSON.parse(readFileSync(recoveryPath, 'utf8')), directReceipt)
    } finally {
      rmSync(recoveryDirectory, { recursive: true, force: true })
    }
    await assert.rejects(
      exportCommittedReceipt({
        ...directInput, plan: directPlan.plan, confirmDigest: 'f'.repeat(64),
      }),
      /explicit confirmation digest changed/u,
    )
    await assert.rejects(
      applyWithDedicatedClients(source, target, {
        ...directInput,
        plan: directPlan.plan,
        confirmDigest: directPlan.plan.planDigest,
      }),
      /already rebound/u,
    )

    const commerceInput = inputFor(data.accounts.commerce)
    const postMigrationPolicy = await target.query(
      `SELECT count(*)::integer AS count
       FROM operations_commerce_order_history_policies
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.commerce.targetId],
    )
    assert.equal(postMigrationPolicy.rows[0].count, 0)
    await assert.rejects(
      planRebind(commerceInput),
      /requires one frozen target order-history policy/u,
    )
    await target.query(
      `INSERT INTO operations_commerce_order_history_policies (
         organization_id,integration_account_id,provider,history_mode,
         ingestion_floor,frozen_at,configured_by
       ) VALUES (
         $1::uuid,$2::uuid,'shopify','last_30_days',
         '2026-08-05T12:00:00.000Z','2026-09-04T12:00:00.000Z',NULL
       )`,
      [data.targetOrg, data.accounts.commerce.targetId],
    )
    await assert.rejects(
      planRebind(commerceInput),
      /target order-history policy attribution is invalid/u,
    )
    await target.query(
      `UPDATE operations_commerce_order_history_policies
       SET configured_by = 'different-operator@example.com'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.commerce.targetId],
    )
    await assert.rejects(
      planRebind(commerceInput),
      /target order-history policy attribution is invalid/u,
    )
    await target.query(
      `UPDATE operations_commerce_order_history_policies
       SET configured_by = $3
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.commerce.targetId, actor],
    )
    const commercePlan = await planRebind(commerceInput)
    assert.equal(commercePlan.plan.providers.length, 1)
    assert.equal(commercePlan.plan.selectedSourceAccountGlobalId, data.accounts.commerce.sourceGlobalId)
    assert.deepEqual(commercePlan.plan.providers[0].orderHistoryPolicy, {
      provider: 'shopify',
      historyMode: 'last_30_days',
      ingestionFloor: '2026-08-05T12:00:00.000Z',
      frozenAt: '2026-09-04T12:00:00.000Z',
      configuredBy: actor,
    })
    assert.match(
      commercePlan.plan.providers[0].targetPlaceholder.configuration.configurationSha256,
      /^[a-f0-9]{64}$/u,
    )
    assert.deepEqual(
      commercePlan.plan.providers[0].targetPlaceholder.storeSyncControl,
      {
        desiredState: 'paused',
        explicitChoice: true,
        revision: 1,
        stateSha256:
          commercePlan.plan.providers[0].targetPlaceholder.storeSyncControl.stateSha256,
      },
    )
    assert.match(
      commercePlan.plan.providers[0].targetPlaceholder.storeSyncControl.stateSha256,
      /^[a-f0-9]{64}$/u,
    )
    assert.equal(JSON.stringify(commercePlan.plan).includes('fixture-shopify-client-secret'), false)
    await target.query(
      `UPDATE operations_commerce_order_history_policies
       SET ingestion_floor = '2026-08-06T12:00:00.000Z'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.commerce.targetId],
    )
    await assert.rejects(
      applyWithDedicatedClients(source, target, {
        ...commerceInput,
        plan: commercePlan.plan,
        confirmDigest: commercePlan.plan.planDigest,
      }),
      /reviewed rebind provider evidence no longer matches/u,
    )
    await target.query(
      `UPDATE operations_commerce_order_history_policies
       SET ingestion_floor = '2026-08-05T12:00:00.000Z'
      WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.commerce.targetId],
    )
    const assertPostValidationDriftRejected = async (mutate, restore) => {
      const baseVerifier = fakeVerifier(data)
      let mutated = false
      let reconciliationCallsForDrift = 0
      const driftVerifier = {
        ...baseVerifier,
        async commerce(...values) {
          const evidence = await baseVerifier.commerce(...values)
          if (!mutated) {
            await mutate()
            mutated = true
          }
          return evidence
        },
        async reconcileShopify(...values) {
          reconciliationCallsForDrift += 1
          return baseVerifier.reconcileShopify(...values)
        },
      }
      try {
        await assert.rejects(
          applyWithDedicatedClients(source, target, {
            ...commerceInput,
            verifier: driftVerifier,
            plan: commercePlan.plan,
            confirmDigest: commercePlan.plan.planDigest,
          }),
          /commerce placeholder changed before provider reconciliation/u,
        )
        assert.equal(reconciliationCallsForDrift, 0)
      } finally {
        await restore()
      }
    }
    await assertPostValidationDriftRejected(
      () => target.query(
        `UPDATE operations_integration_accounts
         SET configuration = configuration || '{"unreviewedCapability":"sandbox_label"}'::jsonb
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [data.targetOrg, data.accounts.commerce.targetId],
      ),
      () => target.query(
        `UPDATE operations_integration_accounts
         SET configuration = configuration - 'unreviewedCapability'
         WHERE organization_id = $1::uuid AND id = $2::uuid`,
        [data.targetOrg, data.accounts.commerce.targetId],
      ),
    )
    await assertPostValidationDriftRejected(
      () => target.query(
        `UPDATE operations_commerce_store_sync_controls
         SET reason = 'Unreviewed Store sync control mutation'
         WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
        [data.targetOrg, data.accounts.commerce.targetId],
      ),
      () => target.query(
        `UPDATE operations_commerce_store_sync_controls
         SET reason = 'Awaiting provider rebind'
         WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
        [data.targetOrg, data.accounts.commerce.targetId],
      ),
    )
    const baseConcurrencyVerifier = fakeVerifier(data)
    let validationArrivals = 0
    let releaseValidations
    let reconciliationCalls = 0
    const bothValidations = new Promise((resolve) => { releaseValidations = resolve })
    const concurrentVerifier = {
      ...baseConcurrencyVerifier,
      async commerce(...values) {
        const evidence = await baseConcurrencyVerifier.commerce(...values)
        validationArrivals += 1
        if (validationArrivals === 2) releaseValidations()
        await bothValidations
        return evidence
      },
      async reconcileShopify(...values) {
        reconciliationCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 100))
        return baseConcurrencyVerifier.reconcileShopify(...values)
      },
    }
    const [sourceA, sourceB, targetA, targetB] = await Promise.all([
      source.connect(), source.connect(), target.connect(), target.connect(),
    ])
    let concurrentResults
    try {
      const concurrentInput = {
        ...commerceInput,
        verifier: concurrentVerifier,
        plan: commercePlan.plan,
        confirmDigest: commercePlan.plan.planDigest,
      }
      concurrentResults = await Promise.allSettled([
        applyRebind({ ...concurrentInput, source: sourceA, target: targetA }),
        applyRebind({ ...concurrentInput, source: sourceB, target: targetB }),
      ])
    } finally {
      sourceA.release()
      sourceB.release()
      targetA.release()
      targetB.release()
    }
    const fulfilled = concurrentResults.filter((result) => result.status === 'fulfilled')
    const rejected = concurrentResults.filter((result) => result.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.match(
      String(rejected[0].reason?.message || rejected[0].reason),
      /could not serialize access|placeholder changed|already rebound/u,
    )
    assert.equal(reconciliationCalls, 1, 'only the locked winner may reconcile provider state')
    const commerceReceipt = fulfilled[0].value
    assert.equal(commerceReceipt.receipts.length, 1)
    assert.equal(commerceReceipt.providerWrites, 0)

    const authorityBefore = await target.query(
      `SELECT credential_ciphertext, credential_iv, credential_tag
       FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.authorityOrg, data.accounts.authority.authorityIntegrationId],
    )
    const authorityInput = inputFor(data.accounts.authority, {
      managedRebindMaterial: managedMaterial(data, artifact, bindings),
    })
    await assert.rejects(
      planRebind({
        ...authorityInput,
        managedRebindMaterial: {
          ...authorityInput.managedRebindMaterial,
          actor: 'unapproved@example.com',
        },
      }),
      /managed carrier reauthentication approval changed/u,
    )
    await target.query(
      `UPDATE operations_carrier_accounts SET allow_sender_billing = false
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.authorityOrg, data.accounts.authority.authorityIntegrationId],
    )
    await assert.rejects(
      planRebind(authorityInput),
      /production source authority identity changed/u,
    )
    await target.query(
      `UPDATE operations_carrier_accounts
       SET allow_sender_billing = true, address_verification = 'unverified'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.authorityOrg, data.accounts.authority.authorityIntegrationId],
    )
    await assert.rejects(
      planRebind(authorityInput),
      /production source authority identity changed/u,
    )
    await target.query(
      `UPDATE operations_carrier_accounts SET address_verification = 'provider_verified'
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.authorityOrg, data.accounts.authority.authorityIntegrationId],
    )
    const unicodeMaterial = structuredClone(authorityInput.managedRebindMaterial)
    unicodeMaterial.credential.clientSecret = 'fresh-target-fedex-secrét'
    unicodeMaterial.materialDigest = managedRebindMaterialDigest(unicodeMaterial)
    await assert.rejects(
      planRebind({ ...authorityInput, managedRebindMaterial: unicodeMaterial }),
      /Managed carrier client secret is invalid/u,
    )
    const authorityPlan = await planRebind(authorityInput)
    assert.equal(authorityPlan.plan.providers.length, 1)
    assert.equal(authorityPlan.plan.selectedSourceAccountGlobalId, data.accounts.authority.sourceGlobalId)
    assert.equal(
      authorityPlan.plan.providers[0].sourceAuthority.credentialSource,
      'operator_supplied_target_reauthentication',
    )
    assert.equal(
      authorityPlan.plan.providers[0].targetPlaceholder.configuration.authorizationScope,
      'sandbox_rating_only',
    )
    assert.deepEqual(
      authorityPlan.plan.providers[0].targetPlaceholder.configuration.allowedCapabilities,
      [],
    )
    assert.deepEqual(
      authorityPlan.plan.providers[0].targetPlaceholder.configuration.rebindRequestedCapabilities,
      ['sandbox_rate'],
    )
    assert.equal(JSON.stringify(authorityPlan.plan).includes('fresh-target-fedex-secret'), false)
    assert.equal(JSON.stringify(authorityPlan.plan).includes(data.accounts.authority.authorityNumber), false)
    assert.match(
      authorityPlan.plan.providers[0].reauthenticationMaterialFingerprintSha256,
      /^[a-f0-9]{64}$/u,
    )
    await target.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         jsonb_set(
           configuration,
           '{authorizationScope}',
           '"sandbox_fulfillment_diagnostic"'::jsonb
         ),
         '{rebindRequestedCapabilities}',
         '["sandbox_rate","sandbox_label"]'::jsonb
       )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [data.targetOrg, data.accounts.authority.targetId],
    )
    await assert.rejects(
      applyWithDedicatedClients(source, target, {
        ...authorityInput,
        plan: authorityPlan.plan,
        confirmDigest: authorityPlan.plan.planDigest,
      }),
      /reviewed rebind provider evidence no longer matches/u,
    )
    await target.query(
      `UPDATE operations_integration_accounts
       SET configuration = jsonb_set(
         jsonb_set(
           configuration,
           '{authorizationScope}',
           '"sandbox_rating_only"'::jsonb
         ),
         '{rebindRequestedCapabilities}',
         '["sandbox_rate"]'::jsonb
       )
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [data.targetOrg, data.accounts.authority.targetId],
    )
    const substitutedMaterial = structuredClone(authorityInput.managedRebindMaterial)
    substitutedMaterial.credential.clientSecret = 'fresh-target-fedex-secret-substitute'
    substitutedMaterial.materialDigest = managedRebindMaterialDigest(substitutedMaterial)
    await assert.rejects(
      applyWithDedicatedClients(source, target, {
        ...authorityInput,
        managedRebindMaterial: substitutedMaterial,
        plan: authorityPlan.plan,
        confirmDigest: authorityPlan.plan.planDigest,
      }),
      /reviewed rebind provider evidence no longer matches/u,
    )
    const authorityReceipt = await applyWithDedicatedClients(source, target, {
      ...authorityInput,
      plan: authorityPlan.plan,
      confirmDigest: authorityPlan.plan.planDigest,
    })
    assert.equal(authorityReceipt.receipts.length, 1)
    assert.equal(authorityReceipt.providerWrites, 0)
    const authorityAddressEvidence = await target.query(
      `SELECT address_verification, allow_sender_billing
       FROM operations_carrier_accounts
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.authority.targetId],
    )
    assert.deepEqual(authorityAddressEvidence.rows[0], {
      address_verification: 'provider_verified',
      allow_sender_billing: true,
    })

    const materialized = await target.query(
      `SELECT
         (SELECT count(*)::integer FROM operations_integration_accounts
           WHERE organization_id = $1::uuid AND status = 'active') AS active,
         (SELECT count(*)::integer FROM operations_carrier_account_migration_placeholders
           WHERE organization_id = $1::uuid AND state = 'materialized') AS carriers,
         (SELECT count(*)::integer FROM operations_commerce_sync_cursors
           WHERE organization_id = $1::uuid) AS fresh_cursors,
         (SELECT count(*)::integer FROM audit_events
           WHERE organization_id = $1::uuid
             AND event_type = 'operations.migrated_provider_rebind.completed') AS receipts`,
      [data.targetOrg],
    )
    assert.deepEqual(materialized.rows[0], {
      active: 3, carriers: 2, fresh_cursors: 5, receipts: 3,
    })
    const immutableReceipt = await target.query(
      `SELECT id::text FROM audit_events
       WHERE organization_id = $1::uuid
         AND event_type = 'operations.migrated_provider_rebind.completed'
       ORDER BY created_at LIMIT 1`,
      [data.targetOrg],
    )
    await assert.rejects(
      target.query(
        `UPDATE audit_events SET payload = payload || '{"tampered":true}'::jsonb
         WHERE id = $1::uuid`,
        [immutableReceipt.rows[0].id],
      ),
      /migration receipts are immutable, including provider rebind receipts/u,
    )
    await assert.rejects(
      target.query('DELETE FROM audit_events WHERE id = $1::uuid', [immutableReceipt.rows[0].id]),
      /migration receipts are immutable, including provider rebind receipts/u,
    )
    const sourceReceipt = await target.query(
      `SELECT payload FROM audit_events
       WHERE organization_id = $1::uuid
         AND event_type = 'operations.migrated_provider_rebind.completed'
         AND payload->>'planDigest' = $2`,
      [data.targetOrg, directPlan.plan.planDigest],
    )
    const assertMalformedReceiptRejected = async (suffix, mutate) => {
      const malformedPlan = structuredClone(directPlan.plan)
      malformedPlan.createdAt = `2026-09-04T12:00:0${suffix}.000Z`
      malformedPlan.planDigest = reviewedPlanDigest(malformedPlan)
      const malformedPayload = structuredClone(sourceReceipt.rows[0].payload)
      malformedPayload.planDigest = malformedPlan.planDigest
      mutate(malformedPayload)
      malformedPayload.receiptDigest = rebindReceiptDigest(malformedPayload)
      await target.query(
        `INSERT INTO audit_events (
           actor,event_type,aggregate_type,aggregate_id,payload,event_key,
           subject,organization_id,is_system
         ) VALUES (
           $1,'operations.migrated_provider_rebind.completed','workspace_organization',
           $2::text,$3::jsonb,$4,$1,$2::uuid,false
         )`,
        [actor, data.targetOrg, JSON.stringify(malformedPayload),
          `migrated-provider-rebind:migrated-production-provider-rebind-v1:${data.targetOrg}:${malformedPlan.planDigest}`],
      )
      await assert.rejects(
        exportCommittedReceipt({
          ...directInput,
          plan: malformedPlan,
          confirmDigest: malformedPlan.planDigest,
        }),
        /committed rebind receipt is missing or invalid/u,
      )
    }
    await assertMalformedReceiptRejected('1', (payload) => {
      payload.source.organizationReference = 'ga9999999'
    })
    await assertMalformedReceiptRejected('2', (payload) => {
      payload.sourceRowsCopied = {}
    })
    const managed = await target.query(
      `SELECT configuration
       FROM operations_integration_accounts
       WHERE organization_id = $1::uuid AND provider = 'fedex_rest'`,
      [data.targetOrg],
    )
    assert.equal(managed.rows[0].configuration.migrationSourceAuthorityVerified, true)
    assert.equal(managed.rows[0].configuration.senderOriginWarehouseGlobalId, 'gwh1234567')
    assert.deepEqual(managed.rows[0].configuration.allowedCapabilities, ['sandbox_rate'])
    assert.equal(managed.rows[0].configuration.credentialRevealAllowed, false)
    const authorityAfter = await target.query(
      `SELECT credential_ciphertext, credential_iv, credential_tag
       FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.authorityOrg, data.accounts.authority.authorityIntegrationId],
    )
    assert.deepEqual(authorityAfter.rows, authorityBefore.rows)
    const childCredential = await target.query(
      `SELECT credential_ciphertext, credential_iv, credential_tag
       FROM operations_carrier_credentials
       WHERE organization_id = $1::uuid AND integration_account_id = $2::uuid`,
      [data.targetOrg, data.accounts.authority.targetId],
    )
    const childPlaintext = decrypt({
      ciphertext: childCredential.rows[0].credential_ciphertext,
      iv: childCredential.rows[0].credential_iv,
      tag: childCredential.rows[0].credential_tag,
    }, targetKey, carrierCredentialAad(data.targetOrg, 'fedex_rest', 'sandbox'))
    try {
      const childValue = JSON.parse(childPlaintext.toString('utf8'))
      assert.equal(childValue.clientId, 'fresh-target-fedex-client-9088')
      assert.equal(childValue.clientSecret, 'fresh-target-fedex-secret')
      assert.notEqual(childValue.clientId, 'fixture-fedex-client-1073')
    } finally {
      childPlaintext.fill(0)
    }
  } finally {
    await Promise.allSettled([source.end(), target.end()])
  }
}

async function run() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = `clawpilot-provider-rebind-${process.pid}-${randomUUID().slice(0, 8)}`
  let sourceUrl
  let targetUrl
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=provider_rebind',
      '-e', 'POSTGRES_DB=postgres',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const port = Number(command('docker', ['port', container, '5432/tcp']).match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0)
    const adminUrl = `postgresql://postgres:provider_rebind@127.0.0.1:${port}/postgres`
    await waitForPostgres(adminUrl)
    const admin = new Pool({ connectionString: adminUrl, max: 1 })
    const suffix = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 6)}`
    const sourceDatabase = `provider_rebind_source_${suffix}`
    const targetDatabase = `provider_rebind_target_${suffix}`
    await admin.query(`CREATE DATABASE ${sourceDatabase}`)
    await admin.query(`CREATE DATABASE ${targetDatabase}`)
    await admin.end()
    sourceUrl = `postgresql://postgres:provider_rebind@127.0.0.1:${port}/${sourceDatabase}`
    targetUrl = `postgresql://postgres:provider_rebind@127.0.0.1:${port}/${targetDatabase}`
    await runAcceptance(sourceUrl, targetUrl)
  } finally {
    command('docker', ['rm', '-f', container], { timeout: 30_000 })
  }
}

await run()
console.log('Migrated provider rebind disposable PostgreSQL tests passed')
