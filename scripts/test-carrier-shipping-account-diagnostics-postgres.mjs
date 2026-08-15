#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const migration = '0286_carrier_shipping_account_diagnostics.sql'

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim()
}

async function waitForPostgres(pool) {
  const deadline = Date.now() + 45_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function assertRejected(client, sql, message) {
  await assert.rejects(
    () => client.query(sql),
    (error) => String(error?.message || '').includes(message),
  )
}

async function seedFixture(client) {
  await client.query('SET session_replication_role = replica')
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration
     ) VALUES (
       '28600000-0000-4000-8000-000000000010'::uuid,
       'gia2860001',
       '28600000-0000-4000-8000-000000000001'::uuid,
       'ups_rest', 'carrier', 'production', 'Diagnostic UPS production',
       'active',
       '{"allowedCapabilities":["production_rate"]}'::jsonb
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four,
       account_number_last_four, verification_status, verified_at,
       credential_fingerprint, credential_kind,
       credential_identifier_last_four
     ) VALUES (
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000010'::uuid,
       decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
       decode(repeat('00', 16), 'hex'), 1, '0010', '0010',
       'verified', now(),
       operations_carrier_credential_fingerprint(
         1, decode('01', 'hex'), decode(repeat('00', 12), 'hex'),
         decode(repeat('00', 16), 'hex')
       ), 'oauth_client_credentials', '0010'
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv,
       account_number_tag, account_number_last_four,
       account_number_fingerprint, registered_address,
       registered_address_fingerprint, allow_sender_billing, status
     ) VALUES (
       '28600000-0000-4000-8000-000000000020'::uuid,
       'gac2860001',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000010'::uuid,
       'Diagnostic UPS account', 'Diagnostic UPS account',
       'ciphertext', 'iv', 'tag', '0020',
       repeat('a', 64),
       '{
         "line1":"1 Test Street",
         "city":"Hartford",
         "region":"CT",
         "postalCode":"06103",
         "countryCode":"US"
       }'::jsonb,
       repeat('b', 64), true, 'active'
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv,
       account_number_tag, account_number_last_four,
       account_number_fingerprint, registered_address,
       registered_address_fingerprint, allow_sender_billing, status
     ) VALUES (
       '28600000-0000-4000-8000-000000000021'::uuid,
       'gac2860002',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000010'::uuid,
       'Second diagnostic UPS account', 'Second diagnostic UPS account',
       'ciphertext-2', 'iv-2', 'tag-2', '0021',
       repeat('f', 64),
       '{
         "line1":"1 Test Street",
         "city":"Hartford",
         "region":"CT",
         "postalCode":"06103",
         "countryCode":"US"
       }'::jsonb,
       repeat('9', 64), true, 'active'
     )`,
  )
  await client.query(
    `INSERT INTO operations_activation_scopes (
       organization_id, data_pipeline_id, state, revision
     ) VALUES (
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000030'::uuid,
       'shadow', 1
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       id, global_id, organization_id, integration_account_id,
       carrier_account_id, provider, environment, purpose,
       adapter_version, credential_version, request_hash,
       redacted_request, redacted_response, status,
       requested_at, completed_at, billing_relationship,
       billing_selection_snapshot
     ) VALUES (
       '28600000-0000-4000-8000-000000000040'::uuid,
       'grq2860001',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000010'::uuid,
       '28600000-0000-4000-8000-000000000020'::uuid,
       'ups_rest', 'production', 'shipping_account_diagnostic',
       'ups-rest-v1', 1, repeat('c', 64),
       '{"shipment":{"destinationFingerprint":"fixed"}}'::jsonb,
       '{"rates":[{"serviceCode":"03","amount":"12.34","currency":"USD"}]}'::jsonb,
       'succeeded', now() - interval '1 second', now(), 'sender',
       jsonb_build_object(
         'relationship', 'sender',
         'credentialFingerprint', (
           SELECT credential_fingerprint
           FROM operations_carrier_credentials
           WHERE organization_id =
             '28600000-0000-4000-8000-000000000001'::uuid
             AND integration_account_id =
               '28600000-0000-4000-8000-000000000010'::uuid
         ),
         'accountNumberFingerprint', repeat('a', 64),
         'registeredAddressFingerprint', repeat('b', 64),
         'senderName', 'Diagnostic UPS account'
       )
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       id, global_id, organization_id, integration_account_id,
       carrier_account_id, provider, environment, purpose,
       adapter_version, credential_version, request_hash,
       redacted_request, redacted_response, status,
       requested_at, completed_at, billing_relationship,
       billing_selection_snapshot
     )
     SELECT fixture.id, fixture.global_id,
            source.organization_id, source.integration_account_id,
            fixture.carrier_account_id, source.provider,
            source.environment, source.purpose, source.adapter_version,
            source.credential_version, fixture.request_hash,
            source.redacted_request, source.redacted_response, source.status,
            source.requested_at, source.completed_at,
            source.billing_relationship,
            source.billing_selection_snapshot || jsonb_build_object(
              'accountNumberFingerprint',
                fixture_account.account_number_fingerprint,
              'registeredAddressFingerprint',
                fixture_account.registered_address_fingerprint,
              'senderName', fixture_account.sender_name
            )
     FROM operations_carrier_rate_requests source
     CROSS JOIN (VALUES
       (
         '28600000-0000-4000-8000-000000000041'::uuid,
         'grq2860002',
         '28600000-0000-4000-8000-000000000020'::uuid,
         repeat('4', 64)
       ),
       (
         '28600000-0000-4000-8000-000000000042'::uuid,
         'grq2860003',
         '28600000-0000-4000-8000-000000000021'::uuid,
         repeat('5', 64)
       ),
       (
         '28600000-0000-4000-8000-000000000043'::uuid,
         'grq2860004',
         '28600000-0000-4000-8000-000000000020'::uuid,
         repeat('6', 64)
       )
     ) fixture(id, global_id, carrier_account_id, request_hash)
     JOIN operations_carrier_accounts fixture_account
       ON fixture_account.organization_id = source.organization_id
      AND fixture_account.id = fixture.carrier_account_id
     WHERE source.id =
       '28600000-0000-4000-8000-000000000040'::uuid`,
  )
  await client.query(
    `INSERT INTO operations_integration_accounts (
       id, global_id, organization_id, provider, integration_type,
       environment, display_name, status, configuration
     ) VALUES (
       '28600000-0000-4000-8000-000000000011'::uuid,
       'gia2860002',
       '28600000-0000-4000-8000-000000000001'::uuid,
       'ups_rest', 'carrier', 'sandbox', 'Diagnostic UPS sandbox',
       'active',
       '{"allowedCapabilities":["sandbox_rate","sandbox_label"]}'::jsonb
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_credentials (
       organization_id, integration_account_id,
       credential_ciphertext, credential_iv, credential_tag,
       credential_version, client_id_last_four,
       account_number_last_four, verification_status, verified_at,
       credential_fingerprint, credential_kind,
       credential_identifier_last_four
     ) VALUES (
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000011'::uuid,
       decode('03', 'hex'), decode(repeat('01', 12), 'hex'),
       decode(repeat('01', 16), 'hex'), 1, '0011', '0022',
       'verified', now(),
       operations_carrier_credential_fingerprint(
         1, decode('03', 'hex'), decode(repeat('01', 12), 'hex'),
         decode(repeat('01', 16), 'hex')
       ), 'oauth_client_credentials', '0011'
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_accounts (
       id, global_id, organization_id, integration_account_id,
       display_name, sender_name,
       account_number_ciphertext, account_number_iv,
       account_number_tag, account_number_last_four,
       account_number_fingerprint, registered_address,
       registered_address_fingerprint, allow_sender_billing, status
     ) VALUES (
       '28600000-0000-4000-8000-000000000022'::uuid,
       'gac2860003',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000011'::uuid,
       'Diagnostic sandbox account', 'Diagnostic sandbox account',
       'sandbox-ciphertext', 'sandbox-iv', 'sandbox-tag', '0022',
       repeat('8', 64),
       '{
         "line1":"2 Test Street",
         "city":"Hartford",
         "region":"CT",
         "postalCode":"06103",
         "countryCode":"US"
       }'::jsonb,
       repeat('7', 64), true, 'active'
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_rate_requests (
       id, global_id, organization_id, integration_account_id,
       carrier_account_id, provider, environment, purpose,
       adapter_version, credential_version, request_hash,
       redacted_request, redacted_response, status,
       requested_at, completed_at, billing_relationship,
       billing_selection_snapshot
     ) VALUES (
       '28600000-0000-4000-8000-000000000044'::uuid,
       'grq2860005',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000011'::uuid,
       '28600000-0000-4000-8000-000000000022'::uuid,
       'ups_rest', 'sandbox', 'sandbox_rate_test',
       'ups-rest-v1', 1, repeat('7', 64),
       '{"shipment":{"destinationFingerprint":"sandbox-fixed"}}'::jsonb,
       '{"rates":[{"serviceCode":"03","amount":"8.50","currency":"USD"}]}'::jsonb,
       'succeeded', now() - interval '1 minute', now(), 'sender',
       '{"relationship":"sender"}'::jsonb
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_rate_test_label_attempts (
       id, global_id, organization_id, rate_request_id,
       integration_account_id, carrier_account_id, action, state,
       provider, environment, credential_version, service_code,
       selected_rate, destination_fingerprint, adapter_version, reason,
       idempotency_key, request_hash, redacted_request, redacted_response
     ) VALUES (
       '28600000-0000-4000-8000-000000000054'::uuid,
       'gsa2860005',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000044'::uuid,
       '28600000-0000-4000-8000-000000000011'::uuid,
       '28600000-0000-4000-8000-000000000022'::uuid,
       'create', 'prepared', 'ups_rest', 'sandbox', 1, '03',
       '{"serviceCode":"03","serviceName":"UPS Ground","amount":"8.50","currency":"USD"}'::jsonb,
       repeat('6', 64), 'ups-rest-v1', 'Sandbox create fixture',
       'sandbox-create-fixture-0001', repeat('5', 64), '{}'::jsonb, '{}'::jsonb
     )`,
  )
  await client.query(
    `INSERT INTO operations_carrier_rate_test_labels (
       id, global_id, organization_id, rate_request_id,
       integration_account_id, carrier_account_id, provider, environment,
       credential_version, account_number_fingerprint, rate_request_hash,
       destination_fingerprint, service_code, service_name, rate_type,
       rated_amount, rated_currency, provider_label_id, tracking_number,
       format, media_size, label_payload, content_sha256,
       provider_reference, redacted_provider_evidence, create_attempt_id,
       status, source_kind, provider_image_type, provider_stock_type
     ) VALUES (
       '28600000-0000-4000-8000-000000000080'::uuid,
       'gsl2860001',
       '28600000-0000-4000-8000-000000000001'::uuid,
       '28600000-0000-4000-8000-000000000044'::uuid,
       '28600000-0000-4000-8000-000000000011'::uuid,
       '28600000-0000-4000-8000-000000000022'::uuid,
       'ups_rest', 'sandbox', 1, repeat('8', 64), repeat('7', 64),
       repeat('6', 64), '03', 'UPS Ground', 'NEGOTIATED',
       '8.50', 'USD', 'sandbox-provider-label', '1ZSANDBOXTRACKING',
       'ZPL', 'label_4x6', convert_to('^XA^XZ', 'UTF8'), repeat('4', 64),
       'sandbox-provider-reference', '{}'::jsonb,
       '28600000-0000-4000-8000-000000000054'::uuid,
       'created', 'provider_native', 'ZPL', 'HEIGHT_6_WIDTH_4'
     )`,
  )
  await client.query(
    `ALTER TABLE operations_carrier_rate_test_label_attempts
       ENABLE ALWAYS TRIGGER
       validate_operations_carrier_shipping_diagnostic_attempt`,
  )
  await client.query(
    `ALTER TABLE operations_carrier_rate_test_label_attempts
       ENABLE ALWAYS TRIGGER
       maintain_operations_carrier_shipping_diagnostic_authority_lease`,
  )
  await client.query(
    `ALTER TABLE operations_carrier_rate_test_labels
       ENABLE ALWAYS TRIGGER
       validate_operations_carrier_shipping_diagnostic_label`,
  )
  for (const [table, trigger] of [
    [
      'operations_activation_scopes',
      'protect_operations_carrier_shipping_diagnostic_activation',
    ],
    [
      'operations_integration_accounts',
      'protect_operations_carrier_shipping_diagnostic_integration',
    ],
    [
      'operations_carrier_credentials',
      'protect_operations_carrier_shipping_diagnostic_credential',
    ],
    [
      'operations_carrier_accounts',
      'protect_operations_carrier_shipping_diagnostic_account',
    ],
  ]) {
    await client.query(
      `ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`,
    )
  }
}

function attemptInsert({
  id,
  globalId,
  action = 'create',
  idempotencyKey,
  integrationAccountId = '28600000-0000-4000-8000-000000000010',
  carrierAccountId = '28600000-0000-4000-8000-000000000020',
  rateRequestId = '28600000-0000-4000-8000-000000000040',
  credentialVersion = 1,
}) {
  return `INSERT INTO operations_carrier_rate_test_label_attempts (
    id, global_id, organization_id, rate_request_id,
    integration_account_id, carrier_account_id, action, state,
    provider, environment, credential_version, service_code,
    selected_rate, destination_fingerprint, adapter_version, reason,
    idempotency_key, request_hash, redacted_request, redacted_response
  ) VALUES (
    '${id}'::uuid, '${globalId}',
    '28600000-0000-4000-8000-000000000001'::uuid,
    '${rateRequestId}'::uuid,
    '${integrationAccountId}'::uuid, '${carrierAccountId}'::uuid,
    '${action}', 'prepared', 'ups_rest', 'production',
    ${credentialVersion}, '03',
    '{"serviceCode":"03","serviceName":"UPS Ground","amount":"12.34","currency":"USD"}'::jsonb,
    repeat('d', 64), 'ups-rest-v1', 'Disposable diagnostic test',
    '${idempotencyKey}', repeat('e', 64), '{}'::jsonb, '{}'::jsonb
  )`
}

function sandboxVoidAttemptInsert({
  id,
  globalId,
  idempotencyKey,
  integrationAccountId = '28600000-0000-4000-8000-000000000011',
  carrierAccountId = '28600000-0000-4000-8000-000000000022',
  environment = 'sandbox',
}) {
  return `INSERT INTO operations_carrier_rate_test_label_attempts (
    id, global_id, organization_id, rate_request_id,
    integration_account_id, carrier_account_id, label_id, action, state,
    provider, environment, credential_version, service_code,
    selected_rate, destination_fingerprint, adapter_version, reason,
    idempotency_key, request_hash, redacted_request, redacted_response
  ) VALUES (
    '${id}'::uuid, '${globalId}',
    '28600000-0000-4000-8000-000000000001'::uuid,
    '28600000-0000-4000-8000-000000000044'::uuid,
    '${integrationAccountId}'::uuid, '${carrierAccountId}'::uuid,
    '28600000-0000-4000-8000-000000000080'::uuid,
    'void', 'prepared', 'ups_rest', '${environment}', 2, '03',
    '{"serviceCode":"03","serviceName":"UPS Ground","amount":"8.50","currency":"USD"}'::jsonb,
    repeat('6', 64), 'ups-rest-v1', 'Sandbox void after rotation',
    '${idempotencyKey}', repeat('3', 64), '{}'::jsonb, '{}'::jsonb
  )`
}

async function exerciseSandboxVoidAfterCredentialRotation(client) {
  await client.query(
    `UPDATE operations_carrier_credentials
     SET credential_ciphertext = decode('04', 'hex'),
         credential_version = 2,
         credential_fingerprint = operations_carrier_credential_fingerprint(
           2, decode('04', 'hex'), credential_iv, credential_tag
         ),
         verification_status = 'verified',
         verified_at = now()
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid
       AND integration_account_id =
         '28600000-0000-4000-8000-000000000011'::uuid`,
  )
  await client.query(
    sandboxVoidAttemptInsert({
      id: '28600000-0000-4000-8000-000000000081',
      globalId: 'gsa2860031',
      idempotencyKey: 'sandbox-rotated-void-0001',
    }),
  )
  await assertRejected(
    client,
    sandboxVoidAttemptInsert({
      id: '28600000-0000-4000-8000-000000000082',
      globalId: 'gsa2860032',
      idempotencyKey: 'sandbox-wrong-account-0001',
      carrierAccountId: '28600000-0000-4000-8000-000000000020',
    }),
    'Carrier shipping diagnostic must bind exact successful rate evidence',
  )
  await assertRejected(
    client,
    sandboxVoidAttemptInsert({
      id: '28600000-0000-4000-8000-000000000083',
      globalId: 'gsa2860033',
      idempotencyKey: 'sandbox-wrong-environment-0001',
      environment: 'production',
    }),
    'Carrier shipping diagnostic must bind exact successful rate evidence',
  )
}

async function enableProductionCreateAuthority(client) {
  await client.query(
    `UPDATE operations_integration_accounts
     SET configuration =
       '{"allowedCapabilities":["production_rate","production_label"]}'::jsonb,
         status = 'active'
     WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
  )
  await client.query(
    `UPDATE operations_activation_scopes
     SET state = 'active', revision = revision + 1
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid`,
  )
}

async function reconcilePreparedCreateAsNoActiveLabel(client, id) {
  const reconciliationKey = `diagnostic-reconcile:${id}`
  await client.query(
    `UPDATE operations_carrier_rate_test_label_attempts
     SET state = 'unknown', completed_at = now(),
         error_code = 'CARRIER_PROVIDER_OUTCOME_UNKNOWN'
     WHERE id = $1::uuid`,
    [id],
  )
  await client.query(
    `UPDATE operations_carrier_rate_test_label_attempts
     SET state = 'failed',
         reconciliation_outcome = 'confirmed_no_active_label',
         reconciliation_reason = 'Disposable PostgreSQL provider check',
         reconciliation_idempotency_key = $2,
         reconciled_at = now()
     WHERE id = $1::uuid`,
    [id, reconciliationKey],
  )
}

async function exerciseProductionAccountFence(client) {
  await enableProductionCreateAuthority(client)
  const firstId = '28600000-0000-4000-8000-000000000060'
  await client.query(
    attemptInsert({
      id: firstId,
      globalId: 'gsa2860010',
      idempotencyKey: 'diagnostic-account-fence-0001',
    }),
  )
  await assertRejected(
    client,
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000061',
      globalId: 'gsa2860011',
      idempotencyKey: 'diagnostic-account-fence-0002',
      rateRequestId: '28600000-0000-4000-8000-000000000041',
    }),
    'operations_carrier_test_attempts_live_account_open_unique',
  )
  await client.query(
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000062',
      globalId: 'gsa2860012',
      idempotencyKey: 'diagnostic-second-account-0001',
      carrierAccountId: '28600000-0000-4000-8000-000000000021',
      rateRequestId: '28600000-0000-4000-8000-000000000042',
    }),
  )
  await reconcilePreparedCreateAsNoActiveLabel(client, firstId)
  await client.query(
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000063',
      globalId: 'gsa2860013',
      idempotencyKey: 'diagnostic-account-after-reconcile-0001',
      rateRequestId: '28600000-0000-4000-8000-000000000041',
    }),
  )
  await client.query(
    `DELETE FROM operations_carrier_rate_test_label_attempts
     WHERE id IN (
       '28600000-0000-4000-8000-000000000060'::uuid,
       '28600000-0000-4000-8000-000000000062'::uuid,
       '28600000-0000-4000-8000-000000000063'::uuid
     )`,
  )
}

async function exerciseProductionAuthorityInterlocks(pool, client) {
  await enableProductionCreateAuthority(client)
  const peer = await pool.connect()
  try {
    await peer.query('SET session_replication_role = replica')
    await peer.query(`SET lock_timeout = '5s'`)
    await client.query('BEGIN')
    await client.query(
      attemptInsert({
        id: '28600000-0000-4000-8000-000000000070',
        globalId: 'gsa2860020',
        idempotencyKey: 'diagnostic-active-race-0001',
        rateRequestId: '28600000-0000-4000-8000-000000000043',
      }),
    )
    const downgrade = peer.query(
      `UPDATE operations_activation_scopes
       SET state = 'shadow', revision = revision + 1
       WHERE organization_id =
         '28600000-0000-4000-8000-000000000001'::uuid`,
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await client.query('COMMIT')
    const downgradeResult = await downgrade
    assert.match(
      String(downgradeResult.error?.message || ''),
      /Operations Active cannot be revoked during a prepared LIVE carrier diagnostic/u,
    )
    const activationAfterRejectedDowngrade = await client.query(
      `SELECT state
       FROM operations_activation_scopes
       WHERE organization_id =
         '28600000-0000-4000-8000-000000000001'::uuid`,
    )
    assert.equal(activationAfterRejectedDowngrade.rows[0]?.state, 'active')
    await reconcilePreparedCreateAsNoActiveLabel(
      client,
      '28600000-0000-4000-8000-000000000070',
    )

    await client.query(
      attemptInsert({
        id: '28600000-0000-4000-8000-000000000072',
        globalId: 'gsa2860022',
        idempotencyKey: 'diagnostic-account-edit-race-0001',
        rateRequestId: '28600000-0000-4000-8000-000000000043',
      }),
    )
    await assertRejected(
      peer,
      `UPDATE operations_carrier_accounts
       SET sender_name = 'Rotated while leased',
           account_number_ciphertext = 'rotated-ciphertext',
           account_number_iv = 'rotated-iv',
           account_number_tag = 'rotated-tag',
           encryption_version = encryption_version + 1,
           account_number_last_four = '9090',
           account_number_fingerprint = repeat('d', 64),
           registered_address = jsonb_set(
             registered_address, '{postalCode}', '"10001"'::jsonb
           ),
           registered_address_fingerprint = repeat('e', 64)
       WHERE id = '28600000-0000-4000-8000-000000000020'::uuid`,
      'LIVE carrier sender account cannot change during a prepared diagnostic',
    )
    await assertRejected(
      peer,
      `UPDATE operations_carrier_credentials
       SET credential_ciphertext = decode('02', 'hex'),
           credential_version = credential_version + 1,
           credential_fingerprint = repeat('7', 64)
       WHERE integration_account_id =
         '28600000-0000-4000-8000-000000000010'::uuid`,
      'LIVE carrier credential cannot change during a prepared diagnostic',
    )
    await reconcilePreparedCreateAsNoActiveLabel(
      client,
      '28600000-0000-4000-8000-000000000072',
    )

    await peer.query('BEGIN')
    await peer.query(
      `UPDATE operations_carrier_accounts
       SET sender_name = 'Committed replacement sender',
           registered_address = jsonb_set(
             registered_address, '{postalCode}', '"10001"'::jsonb
           ),
           registered_address_fingerprint = repeat('e', 64)
       WHERE id = '28600000-0000-4000-8000-000000000020'::uuid`,
    )
    await client.query('BEGIN')
    const createAgainstEditedAccount = client.query(
      attemptInsert({
        id: '28600000-0000-4000-8000-000000000073',
        globalId: 'gsa2860023',
        idempotencyKey: 'diagnostic-account-edit-race-0002',
        rateRequestId: '28600000-0000-4000-8000-000000000043',
      }),
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await peer.query('COMMIT')
    const editedAccountCreateResult = await createAgainstEditedAccount
    assert.match(
      String(editedAccountCreateResult.error?.message || ''),
      /LIVE carrier shipping diagnostic create requires current Active production-label authority/u,
    )
    await client.query('ROLLBACK')
    const accountAfterCreateLostRace = await client.query(
      `SELECT sender_name,
              registered_address_fingerprint,
              (
                SELECT count(*)::integer
                FROM operations_carrier_rate_test_label_attempts
                WHERE id =
                  '28600000-0000-4000-8000-000000000073'::uuid
              ) AS persisted_attempts
       FROM operations_carrier_accounts
       WHERE id = '28600000-0000-4000-8000-000000000020'::uuid`,
    )
    assert.deepEqual(accountAfterCreateLostRace.rows[0], {
      sender_name: 'Committed replacement sender',
      registered_address_fingerprint: 'e'.repeat(64),
      persisted_attempts: 0,
    })
    await client.query(
      `UPDATE operations_carrier_accounts
       SET sender_name = 'Diagnostic UPS account',
           registered_address = jsonb_set(
             registered_address, '{postalCode}', '"06103"'::jsonb
           ),
           registered_address_fingerprint = repeat('b', 64)
       WHERE id = '28600000-0000-4000-8000-000000000020'::uuid`,
    )

    await peer.query('BEGIN')
    await peer.query(
      `UPDATE operations_integration_accounts
       SET configuration =
         '{"allowedCapabilities":["production_rate"]}'::jsonb
       WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
    )
    await client.query('BEGIN')
    const create = client.query(
      attemptInsert({
        id: '28600000-0000-4000-8000-000000000071',
        globalId: 'gsa2860021',
        idempotencyKey: 'diagnostic-capability-race-0001',
        rateRequestId: '28600000-0000-4000-8000-000000000043',
      }),
    ).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await peer.query('COMMIT')
    const createResult = await create
    assert.match(
      String(createResult.error?.message || ''),
      /(?:LIVE carrier shipping diagnostic create requires current Active production-label authority|LIVE carrier authority cannot be revoked during a prepared diagnostic)/u,
    )
    await client.query('ROLLBACK')
    const authorityAfterCreateLostRace = await client.query(
      `SELECT
         configuration->'allowedCapabilities' ? 'production_label'
           AS production_label,
         (
           SELECT count(*)::integer
           FROM operations_carrier_rate_test_label_attempts
           WHERE id = '28600000-0000-4000-8000-000000000071'::uuid
         ) AS persisted_attempts
       FROM operations_integration_accounts
       WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
    )
    assert.deepEqual(authorityAfterCreateLostRace.rows[0], {
      production_label: false,
      persisted_attempts: 0,
    })
    await enableProductionCreateAuthority(client)
    await client.query(
      `DELETE FROM operations_carrier_rate_test_label_attempts
       WHERE id IN (
         '28600000-0000-4000-8000-000000000070'::uuid,
         '28600000-0000-4000-8000-000000000072'::uuid
       )`,
    )
  } finally {
    await peer.query('ROLLBACK').catch(() => undefined)
    peer.release()
  }
}

async function exerciseLineage(client) {
  await client.query(
    `UPDATE operations_integration_accounts
     SET configuration = '{"allowedCapabilities":["production_rate"]}'::jsonb
     WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
  )
  await client.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', revision = revision + 1
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid`,
  )
  await assertRejected(
    client,
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000050',
      globalId: 'gsa2860001',
      idempotencyKey: 'diagnostic-live-shadow-0001',
    }),
    'LIVE carrier shipping diagnostic create requires current Active production-label authority',
  )

  await client.query(
    `UPDATE operations_integration_accounts
     SET configuration =
       '{"allowedCapabilities":["production_rate","production_label"]}'::jsonb
     WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
  )
  await client.query(
    `UPDATE operations_activation_scopes
     SET state = 'active', revision = revision + 1
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid`,
  )
  await assertRejected(
    client,
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000052',
      globalId: 'gsa2860003',
      idempotencyKey: 'diagnostic-live-mismatch-0003',
      credentialVersion: 2,
    }),
    'Carrier shipping diagnostic must bind exact successful rate evidence',
  )

  await client.query(
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000051',
      globalId: 'gsa2860002',
      idempotencyKey: 'diagnostic-live-active-0002',
    }),
  )
  await reconcilePreparedCreateAsNoActiveLabel(
    client,
    '28600000-0000-4000-8000-000000000051',
  )

  await client.query(
    `UPDATE operations_carrier_credentials
     SET credential_version = 2
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid
       AND integration_account_id =
         '28600000-0000-4000-8000-000000000010'::uuid`,
  )

  await client.query(
    `UPDATE operations_integration_accounts
     SET configuration = '{"allowedCapabilities":["production_rate"]}'::jsonb
     WHERE id = '28600000-0000-4000-8000-000000000010'::uuid`,
  )
  await client.query(
    `UPDATE operations_activation_scopes
     SET state = 'shadow', revision = revision + 1
     WHERE organization_id =
       '28600000-0000-4000-8000-000000000001'::uuid`,
  )
  await client.query(
    attemptInsert({
      id: '28600000-0000-4000-8000-000000000053',
      globalId: 'gsa2860004',
      action: 'void',
      idempotencyKey: 'diagnostic-live-void-0004',
      credentialVersion: 2,
    }),
  )
}

async function assertStructure(client) {
  const migrationResult = await client.query(
    `SELECT filename
     FROM schema_migrations
     WHERE filename IN (
       '0285_shopify_carrier_service_configured_carriers.sql',
       '0286_carrier_shipping_account_diagnostics.sql'
     )
     ORDER BY filename`,
  )
  assert.deepEqual(
    migrationResult.rows.map((row) => row.filename),
    [
      '0285_shopify_carrier_service_configured_carriers.sql',
      '0286_carrier_shipping_account_diagnostics.sql',
    ],
  )

  const constraints = await client.query(
    `SELECT constraint_name, pg_get_constraintdef(installed.oid) AS definition
     FROM (VALUES
       ('operations_shopify_carrier_service_config_carriers',
        'operations_shopify_carrier_service_config_carriers_pkey'),
       ('operations_shopify_checkout_rate_receipt_provider_attempts',
        'operations_shopify_checkout_rate_receipt_provider_attempts_pkey'),
       ('operations_pack_rate_run_rate_choices',
        'operations_pack_rate_run_rate_choices_pkey'),
       ('operations_fulfillment_execution_rate_attempts',
        'operations_fulfillment_execution_rate_attempts_pkey'),
       ('operations_pack_rate_runs',
        'operations_pack_rate_runs_selected_carrier_account_fkey'),
       ('operations_pack_rate_run_rate_choices',
        'operations_pack_rate_run_rate_choices_account_fkey'),
       ('operations_shipment_groups',
        'operations_shipment_groups_selected_carrier_account_fkey'),
       ('operations_shipment_groups',
        'operations_shipment_groups_run_account_fkey'),
       ('operations_fulfillment_execution_rate_attempts',
        'operations_fulfillment_rate_attempts_account_fkey')
     ) required(table_name, constraint_name)
     JOIN pg_constraint installed
       ON installed.conrelid = to_regclass(required.table_name)
      AND installed.conname = required.constraint_name
     ORDER BY constraint_name`,
  )
  assert.equal(constraints.rowCount, 9)
  const constraintMap = new Map(
    constraints.rows.map((row) => [row.constraint_name, row.definition]),
  )
  assert.equal(
    constraintMap.get(
      'operations_shopify_carrier_service_config_carriers_pkey',
    ),
    'PRIMARY KEY (organization_id, config_id, carrier_account_id)',
  )
  assert.equal(
    constraintMap.get(
      'operations_shopify_checkout_rate_receipt_provider_attempts_pkey',
    ),
    'PRIMARY KEY (organization_id, receipt_id, carrier_account_id)',
  )
  assert.equal(
    constraintMap.get('operations_pack_rate_run_rate_choices_pkey'),
    'PRIMARY KEY (organization_id, id)',
  )
  assert.equal(
    constraintMap.get(
      'operations_fulfillment_execution_rate_attempts_pkey',
    ),
    'PRIMARY KEY (organization_id, execution_id, carrier_account_id)',
  )
  assert.equal(
    constraintMap.get(
      'operations_pack_rate_runs_selected_carrier_account_fkey',
    ),
    'FOREIGN KEY (organization_id, selected_carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT',
  )
  assert.equal(
    constraintMap.get('operations_pack_rate_run_rate_choices_account_fkey'),
    'FOREIGN KEY (organization_id, carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT',
  )
  assert.equal(
    constraintMap.get(
      'operations_shipment_groups_selected_carrier_account_fkey',
    ),
    'FOREIGN KEY (organization_id, selected_carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT',
  )
  assert.equal(
    constraintMap.get('operations_shipment_groups_run_account_fkey'),
    'FOREIGN KEY (organization_id, fulfillment_pack_rate_run_id, selected_carrier_account_id) REFERENCES operations_pack_rate_runs(organization_id, id, selected_carrier_account_id) ON DELETE RESTRICT',
  )
  assert.equal(
    constraintMap.get('operations_fulfillment_rate_attempts_account_fkey'),
    'FOREIGN KEY (organization_id, carrier_account_id) REFERENCES operations_carrier_accounts(organization_id, id) ON DELETE RESTRICT',
  )

  const exactAccountServiceIndex = await client.query(
    `SELECT installed_index.indisunique AS unique,
            ARRAY(
              SELECT installed_column.attname
              FROM unnest(installed_index.indkey::smallint[])
                WITH ORDINALITY AS indexed_attribute(attnum, ordinal)
              JOIN pg_attribute installed_column
                ON installed_column.attrelid = installed_index.indrelid
               AND installed_column.attnum = indexed_attribute.attnum
              ORDER BY indexed_attribute.ordinal
            )::text[] AS columns,
            pg_get_expr(
              installed_index.indpred,
              installed_index.indrelid
            ) AS predicate
       FROM pg_class installed_index_class
       JOIN pg_index installed_index
         ON installed_index.indexrelid = installed_index_class.oid
      WHERE installed_index_class.relname =
        'operations_pack_rate_choices_account_service_unique'
        AND installed_index.indrelid = to_regclass(
          'operations_pack_rate_run_rate_choices'
        )`,
  )
  assert.deepEqual(exactAccountServiceIndex.rows[0], {
    unique: true,
    columns: [
      'organization_id',
      'run_id',
      'carrier_account_id',
      'provider',
      'service_code',
    ],
    predicate: '(carrier_account_id IS NOT NULL)',
  })

  const diagnosticHealthIndex = await client.query(
    `SELECT pg_get_indexdef(installed_index.indexrelid) AS definition
       FROM pg_class installed_index_class
       JOIN pg_index installed_index
         ON installed_index.indexrelid = installed_index_class.oid
      WHERE installed_index_class.relname =
        'operations_carrier_rate_test_attempts_health_recent_idx'
        AND installed_index.indrelid = to_regclass(
          'operations_carrier_rate_test_label_attempts'
        )
        AND installed_index.indisvalid
        AND installed_index.indisready`,
  )
  assert.match(
    diagnosticHealthIndex.rows[0].definition,
    /\(requested_at DESC, id DESC\) INCLUDE \(environment, state\)$/u,
  )

  const productionFenceIndexes = await client.query(
    `SELECT installed_index_class.relname AS name,
            pg_get_indexdef(installed_index.indexrelid) AS definition
       FROM pg_class installed_index_class
       JOIN pg_index installed_index
         ON installed_index.indexrelid = installed_index_class.oid
      WHERE installed_index_class.relname IN (
        'operations_carrier_test_attempts_live_account_open_unique',
        'operations_carrier_test_labels_live_account_active_unique'
      )
        AND installed_index.indisunique
        AND installed_index.indisvalid
        AND installed_index.indisready
      ORDER BY installed_index_class.relname`,
  )
  assert.equal(productionFenceIndexes.rowCount, 2)
  assert.match(
    productionFenceIndexes.rows[0].definition,
    /\(organization_id, carrier_account_id\) WHERE \(\(environment = 'production'::text\) AND \(action = 'create'::text\) AND \(state = ANY \(ARRAY\['prepared'::text, 'unknown'::text\]\)\)\)$/u,
  )
  assert.match(
    productionFenceIndexes.rows[1].definition,
    /\(organization_id, carrier_account_id\) WHERE \(\(environment = 'production'::text\) AND \(status = 'created'::text\)\)$/u,
  )

  const diagnosticLeaseStructure = await client.query(
    `SELECT required.table_name,
            installed_column.atttypid = 'integer'::regtype AS integer_type,
            installed_column.attnotnull AS not_null,
            pg_get_expr(
              installed_default.adbin, installed_default.adrelid
            ) AS default_expression,
            pg_get_constraintdef(installed_constraint.oid)
              AS constraint_definition
       FROM (VALUES
         ('operations_activation_scopes',
          'operations_activation_scopes_shipping_diagnostic_lease_valid'),
         ('operations_integration_accounts',
          'operations_integration_accounts_shipping_diagnostic_lease_valid'),
         ('operations_carrier_credentials',
          'operations_carrier_credentials_shipping_diagnostic_lease_valid'),
         ('operations_carrier_accounts',
          'operations_carrier_accounts_shipping_diagnostic_lease_valid')
       ) required(table_name, constraint_name)
       JOIN pg_attribute installed_column
         ON installed_column.attrelid = to_regclass(required.table_name)
        AND installed_column.attname =
          'production_shipping_diagnostic_lease_count'
        AND NOT installed_column.attisdropped
       JOIN pg_attrdef installed_default
         ON installed_default.adrelid = installed_column.attrelid
        AND installed_default.adnum = installed_column.attnum
       JOIN pg_constraint installed_constraint
         ON installed_constraint.conrelid = installed_column.attrelid
        AND installed_constraint.conname = required.constraint_name
      ORDER BY required.table_name`,
  )
  assert.equal(diagnosticLeaseStructure.rowCount, 4)
  for (const row of diagnosticLeaseStructure.rows) {
    assert.equal(row.integer_type, true)
    assert.equal(row.not_null, true)
    assert.equal(row.default_expression, '0')
    assert.equal(
      row.constraint_definition,
      'CHECK ((production_shipping_diagnostic_lease_count >= 0))',
    )
  }

  const triggerResult = await client.query(
    `SELECT table_name, trigger_name, function_name, enabled
     FROM (VALUES
       ('operations_shopify_carrier_service_config_carriers',
        'validate_shopify_cs_config_carrier_write',
        'validate_operations_shopify_carrier_service_config_child'),
       ('operations_pack_rate_run_rate_choices',
        'validate_operations_pack_rate_choice_account_write',
        'validate_operations_pack_rate_choice_account'),
       ('operations_shipment_groups',
        'validate_operations_shipment_group_account_write',
        'validate_operations_shipment_group_account'),
       ('operations_pack_rate_runs',
        'validate_operations_pack_rate_account_run_deferred',
        'validate_operations_pack_rate_account_lineage_complete'),
       ('operations_fulfillment_executions',
        'validate_operations_fulfillment_account_execution_deferred',
        'validate_operations_fulfillment_account_lineage_complete'),
       ('operations_shopify_checkout_rate_receipt_provider_attempts',
        'protect_op_shopify_checkout_provider_attempt_write',
        'protect_op_shopify_checkout_provider_attempt'),
       ('operations_carrier_rate_requests',
        'validate_one_off_rate_selection_key_write',
        'validate_one_off_rate_selection_key'),
       ('operations_shopify_checkout_rate_receipts',
        'validate_op_shopify_checkout_attempt_finalization',
        'validate_op_shopify_checkout_attempt_finalization'),
       ('operations_fulfillment_execution_rate_attempts',
        'validate_operations_fulfillment_attempts_deferred',
        'validate_operations_fulfillment_execution'),
       ('operations_carrier_rate_test_labels',
        'validate_operations_carrier_shipping_diagnostic_label',
        'validate_operations_carrier_shipping_diagnostic_lineage'),
       ('operations_carrier_rate_test_label_attempts',
        'validate_operations_carrier_shipping_diagnostic_attempt',
        'validate_operations_carrier_shipping_diagnostic_lineage'),
       ('operations_carrier_rate_test_label_attempts',
        'maintain_operations_carrier_shipping_diagnostic_authority_lease',
        'maintain_operations_carrier_shipping_diagnostic_authority_lease'),
       ('operations_activation_scopes',
        'protect_operations_carrier_shipping_diagnostic_activation',
        'protect_operations_carrier_shipping_diagnostic_authority'),
       ('operations_integration_accounts',
        'protect_operations_carrier_shipping_diagnostic_integration',
        'protect_operations_carrier_shipping_diagnostic_authority'),
       ('operations_carrier_credentials',
        'protect_operations_carrier_shipping_diagnostic_credential',
        'protect_operations_carrier_shipping_diagnostic_authority'),
       ('operations_carrier_accounts',
        'protect_operations_carrier_shipping_diagnostic_account',
        'protect_operations_carrier_shipping_diagnostic_authority')
     ) required(table_name, trigger_name, function_name)
     JOIN LATERAL (
       SELECT trigger.tgenabled AS enabled,
              procedure.proname AS installed_function_name
       FROM pg_trigger trigger
       JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
       WHERE trigger.tgrelid = to_regclass(required.table_name)
         AND trigger.tgname = required.trigger_name
         AND NOT trigger.tgisinternal
     ) installed ON true
     WHERE installed.installed_function_name = required.function_name
       AND installed.enabled IN ('O', 'A')
     ORDER BY table_name, trigger_name`,
  )
  assert.equal(triggerResult.rowCount, 16)

  const exactDiagnosticTriggers = await client.query(
    `SELECT required.trigger_name
       FROM (VALUES
         ('operations_carrier_rate_test_labels',
          'validate_operations_carrier_shipping_diagnostic_label',
          'validate_operations_carrier_shipping_diagnostic_lineage()', 7),
         ('operations_carrier_rate_test_label_attempts',
          'validate_operations_carrier_shipping_diagnostic_attempt',
          'validate_operations_carrier_shipping_diagnostic_lineage()', 7),
         ('operations_carrier_rate_test_label_attempts',
          'maintain_operations_carrier_shipping_diagnostic_authority_lease',
          'maintain_operations_carrier_shipping_diagnostic_authority_lease()', 29),
         ('operations_activation_scopes',
          'protect_operations_carrier_shipping_diagnostic_activation',
          'protect_operations_carrier_shipping_diagnostic_authority()', 19),
         ('operations_integration_accounts',
          'protect_operations_carrier_shipping_diagnostic_integration',
          'protect_operations_carrier_shipping_diagnostic_authority()', 19),
         ('operations_carrier_credentials',
          'protect_operations_carrier_shipping_diagnostic_credential',
          'protect_operations_carrier_shipping_diagnostic_authority()', 19),
         ('operations_carrier_accounts',
          'protect_operations_carrier_shipping_diagnostic_account',
          'protect_operations_carrier_shipping_diagnostic_authority()', 19)
       ) required(table_name, trigger_name, function_signature, trigger_type)
       JOIN pg_trigger installed
         ON installed.tgrelid = to_regclass(required.table_name)
        AND installed.tgname = required.trigger_name
        AND installed.tgfoid = to_regprocedure(required.function_signature)
        AND NOT installed.tgisinternal
        AND installed.tgenabled = 'O'
        AND installed.tgtype = required.trigger_type
        AND installed.tgconstraint = 0
      ORDER BY required.trigger_name`,
  )
  assert.equal(exactDiagnosticTriggers.rowCount, 7)

  const functions = await client.query(
    `SELECT
       to_regprocedure(
         'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
       ) IS NOT NULL AS environment_ready,
       to_regprocedure(
         'validate_one_off_rate_selection_key()'
       ) IS NOT NULL AS one_off_selection,
       to_regprocedure(
         'validate_operations_carrier_shipping_diagnostic_lineage()'
       ) IS NOT NULL AS diagnostic_lineage,
       to_regprocedure(
         'protect_operations_carrier_shipping_diagnostic_authority()'
       ) IS NOT NULL AS diagnostic_authority,
       to_regprocedure(
         'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
       ) IS NOT NULL AS diagnostic_authority_lease,
       to_regprocedure(
         'operations_legacy_shopify_receipt_offer_carrier_account_id(uuid,text,text,text,text,bigint,text)'
       ) IS NOT NULL AS legacy_receipt_offer_bridge,
       to_regprocedure(
         'operations_legacy_shopify_config_carrier_account_id(uuid,text,text)'
       ) IS NOT NULL AS legacy_config_bridge,
       to_regprocedure(
         'operations_legacy_shopify_fulfillment_attempt_carrier_account_id(uuid,uuid,text,boolean)'
       ) IS NOT NULL AS legacy_fulfillment_bridge`,
  )
  assert.deepEqual(functions.rows[0], {
    environment_ready: true,
    one_off_selection: true,
    diagnostic_lineage: true,
    diagnostic_authority: true,
    diagnostic_authority_lease: true,
    legacy_receipt_offer_bridge: true,
    legacy_config_bridge: true,
    legacy_fulfillment_bridge: true,
  })

  const functionBodies = await client.query(
    `SELECT
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'operations_shopify_carrier_configuration_allows_rating(jsonb,text)'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%WHEN ''production'' THEN (%production_rate%'
         AS rating_policy_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%requested_environment IN (''sandbox'', ''production'')%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
         'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
       )), '[[:space:]]+', ' ', 'g')
          LIKE '%carrier_integration.environment = requested_environment%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%carrier_account.id = selected.carrier_account_id%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%operations_shopify_carrier_configuration_allows_rating( carrier_integration.configuration, requested_environment )%'
         AS environment_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%activation.state = ''shadow''%config.id, ''sandbox''%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'operations_shopify_carrier_service_config_is_ready(uuid,uuid)'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%activation.state = ''active''%config.id, ''production''%'
         AS activation_routing_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'derive_operations_legacy_shopify_carrier_selection_key()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%NEW.actor_email IS NOT NULL%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'derive_operations_legacy_shopify_carrier_selection_key()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.carrier_selection_key := operations_shopify_checkout_carrier_selection_key(%'
         AS legacy_selection_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'validate_one_off_rate_selection_key()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%NEW.actor_email IS NULL AND NEW.purpose = ''cartonization_shipment_rate''%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_one_off_rate_selection_key()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_one_off_rate_selection_key()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_one_off_rate_selection_key()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%operations_one_off_carrier_selection_key( NEW.provider,%'
         AS one_off_selection_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'protect_op_shopify_checkout_provider_attempt()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%selected.carrier_account_id = NEW.carrier_account_id%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_op_shopify_checkout_provider_attempt()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%carrier_integration.environment = CASE receipt.activation_state%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_op_shopify_checkout_provider_attempt()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%rate_evidence.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
         AS attempt_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'validate_op_shopify_checkout_attempt_finalization()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%selected.carrier_account_id = attempt.carrier_account_id%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_op_shopify_checkout_attempt_finalization()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%carrier_integration.environment = CASE NEW.activation_state%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
         'validate_op_shopify_checkout_attempt_finalization()'
       )), '[[:space:]]+', ' ', 'g')
           LIKE '%rate_evidence.carrier_selection_key IS DISTINCT FROM operations_shopify_checkout_carrier_selection_key(%'
         AS finalizer_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'validate_operations_carrier_shipping_diagnostic_lineage()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%evidence.purpose = ''shipping_account_diagnostic'' AND evidence.environment <> ''production''%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%evidence.integration_account_id <> NEW.integration_account_id%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%evidence.carrier_account_id <> NEW.carrier_account_id%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.environment IN (''sandbox'', ''production'')%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.environment = ''sandbox''%label.account_number_fingerprint = carrier_account.account_number_fingerprint%integration.environment = ''sandbox''%credential.credential_version = NEW.credential_version%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%production_label%activation.state = ''active''%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%FOR UPDATE OF integration, credential, carrier_account, activation%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%credentialFingerprint%credential.credential_fingerprint%accountNumberFingerprint%carrier_account.account_number_fingerprint%registeredAddressFingerprint%carrier_account.registered_address_fingerprint%senderName%carrier_account.sender_name%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_operations_carrier_shipping_diagnostic_lineage()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%diagnostic_row->>''action'' = ''void''%credential.credential_version = NEW.credential_version%'
         AS diagnostic_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%attempt_row.environment <> ''production''%attempt_row.action <> ''create''%lease_delta := 1%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'maintain_operations_carrier_shipping_diagnostic_authority_lease()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%UPDATE operations_activation_scopes%UPDATE operations_integration_accounts%UPDATE operations_carrier_credentials%UPDATE operations_carrier_accounts%'
         AS diagnostic_lease_body,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'protect_operations_carrier_shipping_diagnostic_authority()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%production_shipping_diagnostic_lease_count%operations_activation_scopes%operations_integration_accounts%operations_carrier_credentials%operations_carrier_accounts%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_operations_carrier_shipping_diagnostic_authority()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%production_rate%production_label%verification_status%allow_sender_billing%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_operations_carrier_shipping_diagnostic_authority()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.credential_ciphertext%NEW.credential_iv%NEW.credential_tag%NEW.credential_fingerprint%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_operations_carrier_shipping_diagnostic_authority()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.account_number_ciphertext%NEW.account_number_iv%NEW.account_number_tag%NEW.encryption_version%NEW.account_number_fingerprint%NEW.registered_address%NEW.registered_address_fingerprint%NEW.sender_name%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'protect_operations_carrier_shipping_diagnostic_authority()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.account_number_last_four%OLD.account_number_ciphertext%OLD.account_number_last_four%OLD.registered_address%OLD.sender_name%'
         AS diagnostic_authority_body`,
  )
  assert.deepEqual(functionBodies.rows[0], {
    rating_policy_body: true,
    environment_body: true,
    activation_routing_body: true,
    legacy_selection_body: true,
    one_off_selection_body: true,
    attempt_body: true,
    finalizer_body: true,
    diagnostic_body: true,
    diagnostic_lease_body: true,
    diagnostic_authority_body: true,
  })

  const deferredTrigger = await client.query(
    `SELECT trigger.tgtype,
            constraint_row.contype,
            constraint_row.condeferrable,
            constraint_row.condeferred
       FROM pg_trigger trigger
       JOIN pg_constraint constraint_row
         ON constraint_row.oid = trigger.tgconstraint
      WHERE trigger.tgrelid = to_regclass('operations_pack_rate_runs')
        AND trigger.tgname =
          'validate_operations_pack_rate_account_run_deferred'
        AND trigger.tgfoid = to_regprocedure(
          'validate_operations_pack_rate_account_lineage_complete()'
        )
        AND trigger.tgenabled = 'O'`,
  )
  assert.deepEqual(deferredTrigger.rows[0], {
    tgtype: 5,
    contype: 't',
    condeferrable: true,
    condeferred: true,
  })
}

async function assertMutatedDeferredTriggerFailsAttestation(client) {
  await client.query(
    `DROP TRIGGER validate_operations_pack_rate_account_run_deferred
       ON operations_pack_rate_runs`,
  )
  await client.query(
    `CREATE TRIGGER validate_operations_pack_rate_account_run_deferred
       AFTER INSERT ON operations_pack_rate_runs
       FOR EACH ROW EXECUTE FUNCTION
         validate_operations_pack_rate_account_lineage_complete()`,
  )
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_trigger trigger
       JOIN pg_constraint constraint_row
         ON constraint_row.oid = trigger.tgconstraint
       WHERE trigger.tgrelid = to_regclass('operations_pack_rate_runs')
         AND trigger.tgname =
           'validate_operations_pack_rate_account_run_deferred'
         AND trigger.tgfoid = to_regprocedure(
           'validate_operations_pack_rate_account_lineage_complete()'
         )
         AND NOT trigger.tgisinternal
         AND trigger.tgenabled = 'O'
         AND trigger.tgtype = 5
         AND constraint_row.contype = 't'
         AND constraint_row.condeferrable
         AND constraint_row.condeferred
     ) AS ready`,
  )
  assert.equal(
    result.rows[0].ready,
    false,
    'Replacing a deferred constraint trigger with an ordinary trigger must fail health attestation',
  )
}

async function assertMutatedOneOffTriggerFailsAttestation(client) {
  await client.query(
    `DROP TRIGGER validate_one_off_rate_selection_key_write
       ON operations_carrier_rate_requests`,
  )
  await client.query(
    `CREATE TRIGGER validate_one_off_rate_selection_key_write
       BEFORE INSERT ON operations_carrier_rate_requests
       FOR EACH ROW EXECUTE FUNCTION validate_one_off_rate_selection_key()`,
  )
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_trigger trigger
       WHERE trigger.tgrelid = to_regclass(
         'operations_carrier_rate_requests'
       )
         AND trigger.tgname = 'validate_one_off_rate_selection_key_write'
         AND trigger.tgfoid = to_regprocedure(
           'validate_one_off_rate_selection_key()'
         )
         AND NOT trigger.tgisinternal
         AND trigger.tgenabled = 'O'
         AND trigger.tgtype = 23
         AND trigger.tgconstraint = 0
     ) AS ready`,
  )
  assert.equal(
    result.rows[0].ready,
    false,
    'Removing UPDATE from the one-off selection trigger must fail health attestation',
  )
}

async function assertMutatedAccountServiceIndexFailsAttestation(client) {
  await client.query(
    `DROP INDEX operations_pack_rate_choices_account_service_unique`,
  )
  await client.query(
    `CREATE UNIQUE INDEX operations_pack_rate_choices_account_service_unique
       ON operations_pack_rate_run_rate_choices (
         organization_id, run_id, provider, carrier_account_id, service_code
       )
       WHERE carrier_account_id IS NOT NULL`,
  )
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_class installed_index_class
       JOIN pg_index installed_index
         ON installed_index.indexrelid = installed_index_class.oid
       WHERE installed_index_class.relname =
         'operations_pack_rate_choices_account_service_unique'
         AND installed_index.indrelid = to_regclass(
           'operations_pack_rate_run_rate_choices'
         )
         AND installed_index.indisunique
         AND ARRAY(
           SELECT installed_column.attname
           FROM unnest(installed_index.indkey::smallint[])
             WITH ORDINALITY AS indexed_attribute(attnum, ordinal)
           JOIN pg_attribute installed_column
             ON installed_column.attrelid = installed_index.indrelid
            AND installed_column.attnum = indexed_attribute.attnum
           ORDER BY indexed_attribute.ordinal
         ) = ARRAY[
           'organization_id', 'run_id', 'carrier_account_id',
           'provider', 'service_code'
         ]::name[]
         AND pg_get_expr(
           installed_index.indpred,
           installed_index.indrelid
         ) = '(carrier_account_id IS NOT NULL)'
     ) AS ready`,
  )
  assert.equal(
    result.rows[0].ready,
    false,
    'Changing the account/service unique-key order must fail health attestation',
  )
}

async function diagnosticFenceIndexReady(client, input) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_class installed_index_class
       JOIN pg_index installed_index
         ON installed_index.indexrelid = installed_index_class.oid
       WHERE installed_index_class.relname = $1
         AND installed_index.indrelid = to_regclass($2)
         AND installed_index.indisunique
         AND installed_index.indisvalid
         AND installed_index.indisready
         AND ARRAY(
           SELECT installed_column.attname
           FROM unnest(installed_index.indkey::smallint[])
             WITH ORDINALITY AS indexed_attribute(attnum, ordinal)
           JOIN pg_attribute installed_column
             ON installed_column.attrelid = installed_index.indrelid
            AND installed_column.attnum = indexed_attribute.attnum
           ORDER BY indexed_attribute.ordinal
         ) = $3::name[]
         AND pg_get_expr(
           installed_index.indpred,
           installed_index.indrelid
         ) = $4
     ) AS ready`,
    [input.indexName, input.tableName, input.columns, input.predicate],
  )
  return result.rows[0].ready
}

async function assertMutatedDiagnosticFenceIndexesFailAttestation(client) {
  const attempts = {
    tableName: 'operations_carrier_rate_test_label_attempts',
    indexName: 'operations_carrier_test_attempts_live_account_open_unique',
    columns: ['organization_id', 'carrier_account_id'],
    predicate:
      "((environment = 'production'::text) AND (action = 'create'::text) AND (state = ANY (ARRAY['prepared'::text, 'unknown'::text])))",
  }
  await client.query(`DROP INDEX ${attempts.indexName}`)
  await client.query(
    `CREATE UNIQUE INDEX ${attempts.indexName}
       ON ${attempts.tableName} (organization_id, rate_request_id, id)
       WHERE environment = 'production'
         AND action = 'create'
         AND state IN ('prepared', 'unknown')`,
  )
  assert.equal(
    await diagnosticFenceIndexReady(client, attempts),
    false,
    'Changing the LIVE attempt fence key must fail health attestation',
  )
  await client.query(`DROP INDEX ${attempts.indexName}`)
  await client.query(
    `CREATE UNIQUE INDEX ${attempts.indexName}
       ON ${attempts.tableName} (organization_id, carrier_account_id)
       WHERE environment = 'production'
         AND action = 'create'
         AND state IN ('prepared', 'unknown')`,
  )

  const labels = {
    tableName: 'operations_carrier_rate_test_labels',
    indexName: 'operations_carrier_test_labels_live_account_active_unique',
    columns: ['organization_id', 'carrier_account_id'],
    predicate:
      "((environment = 'production'::text) AND (status = 'created'::text))",
  }
  await client.query(`DROP INDEX ${labels.indexName}`)
  await client.query(
    `CREATE UNIQUE INDEX ${labels.indexName}
       ON ${labels.tableName} (organization_id, rate_request_id, id)
       WHERE environment = 'production' AND status = 'created'`,
  )
  assert.equal(
    await diagnosticFenceIndexReady(client, labels),
    false,
    'Changing the LIVE active-label fence key must fail health attestation',
  )
  await client.query(`DROP INDEX ${labels.indexName}`)
  await client.query(
    `CREATE UNIQUE INDEX ${labels.indexName}
       ON ${labels.tableName} (organization_id, carrier_account_id)
       WHERE environment = 'production' AND status = 'created'`,
  )
}

async function assertMutatedDiagnosticAuthorityTriggerFailsAttestation(client) {
  await client.query(
    `DROP TRIGGER protect_operations_carrier_shipping_diagnostic_account
       ON operations_carrier_accounts`,
  )
  await client.query(
    `CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_account
       AFTER UPDATE ON operations_carrier_accounts
       FOR EACH ROW EXECUTE FUNCTION
         protect_operations_carrier_shipping_diagnostic_authority()`,
  )
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
       FROM pg_trigger installed_diagnostic_trigger
       WHERE installed_diagnostic_trigger.tgrelid =
         to_regclass('operations_carrier_accounts')
         AND installed_diagnostic_trigger.tgname =
           'protect_operations_carrier_shipping_diagnostic_account'
         AND installed_diagnostic_trigger.tgfoid = to_regprocedure(
           'protect_operations_carrier_shipping_diagnostic_authority()'
         )
         AND NOT installed_diagnostic_trigger.tgisinternal
         AND installed_diagnostic_trigger.tgenabled = 'O'
         AND installed_diagnostic_trigger.tgtype = 19
         AND installed_diagnostic_trigger.tgconstraint = 0
     ) AS ready`,
  )
  assert.equal(
    result.rows[0].ready,
    false,
    'Changing a LIVE authority guard from BEFORE to AFTER must fail health attestation',
  )
  await client.query(
    `DROP TRIGGER protect_operations_carrier_shipping_diagnostic_account
       ON operations_carrier_accounts`,
  )
  await client.query(
    `CREATE TRIGGER protect_operations_carrier_shipping_diagnostic_account
       BEFORE UPDATE ON operations_carrier_accounts
       FOR EACH ROW EXECUTE FUNCTION
         protect_operations_carrier_shipping_diagnostic_authority()`,
  )
}

async function assertMutatedDiagnosticAuthorityBodyFailsAttestation(client) {
  await client.query(
    `CREATE OR REPLACE FUNCTION
       protect_operations_carrier_shipping_diagnostic_authority()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
  )
  const result = await client.query(
    `SELECT
       to_regprocedure(
         'protect_operations_carrier_shipping_diagnostic_authority()'
       ) IS NOT NULL AS same_signature_present,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'protect_operations_carrier_shipping_diagnostic_authority()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%production_shipping_diagnostic_lease_count%operations_activation_scopes%operations_integration_accounts%operations_carrier_credentials%operations_carrier_accounts%'
       AND regexp_replace(pg_get_functiondef(to_regprocedure(
         'protect_operations_carrier_shipping_diagnostic_authority()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%NEW.account_number_ciphertext%NEW.account_number_last_four%NEW.registered_address%NEW.sender_name%'
         AS body_attested`,
  )
  assert.deepEqual(result.rows[0], {
    same_signature_present: true,
    body_attested: false,
  })
}

async function assertMutatedFunctionBodyFailsAttestation(client) {
  await client.query(
    `CREATE OR REPLACE FUNCTION
       operations_shopify_carrier_service_config_environment_is_ready(
         requested_organization_id uuid,
         requested_config_id uuid,
         requested_environment text
       )
     RETURNS boolean
     LANGUAGE sql
     STABLE
     AS $$ SELECT false $$`,
  )
  const result = await client.query(
    `SELECT
       to_regprocedure(
         'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
       ) IS NOT NULL AS same_signature_present,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%requested_environment IN (''sandbox'', ''production'')%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'operations_shopify_carrier_service_config_environment_is_ready(uuid,uuid,text)'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%carrier_integration.environment = requested_environment%'
         AS body_attested`,
  )
  assert.deepEqual(result.rows[0], {
    same_signature_present: true,
    body_attested: false,
  })
}

async function assertMutatedOneOffFunctionBodyFailsAttestation(client) {
  await client.query(
    `CREATE OR REPLACE FUNCTION validate_one_off_rate_selection_key()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $$ BEGIN RETURN NEW; END $$`,
  )
  const result = await client.query(
    `SELECT
       to_regprocedure('validate_one_off_rate_selection_key()') IS NOT NULL
         AS same_signature_present,
       regexp_replace(pg_get_functiondef(to_regprocedure(
         'validate_one_off_rate_selection_key()'
       )), '[[:space:]]+', ' ', 'g')
         LIKE '%NEW.actor_email IS NULL AND NEW.purpose = ''cartonization_shipment_rate''%'
         AND regexp_replace(pg_get_functiondef(to_regprocedure(
           'validate_one_off_rate_selection_key()'
         )), '[[:space:]]+', ' ', 'g')
           LIKE '%NEW.carrier_selection_key = operations_shopify_checkout_carrier_selection_key(%'
         AS body_attested`,
  )
  assert.deepEqual(result.rows[0], {
    same_signature_present: true,
    body_attested: false,
  })
}

async function main() {
  const docker = spawnSync('docker', ['info'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'ignore',
  })
  if (docker.status !== 0) {
    console.log(
      'Carrier shipping diagnostic PostgreSQL acceptance skipped (Docker unavailable).',
    )
    return
  }

  const containerName = `clawpilot-carrier-diagnostic-${process.pid}`
  const port = command('node', [
    '-e',
    `const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})`,
  ])
  const databaseUrl =
    `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_test`
  let pool = null

  try {
    command('docker', [
      'run', '--detach', '--rm', '--name', containerName,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=clawpilot_test',
      '-p', `${port}:5432`,
      'pgvector/pgvector:pg16',
    ])
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    await waitForPostgres(pool)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    })

    const client = await pool.connect()
    try {
      await assertStructure(client)
      await seedFixture(client)
      await exerciseProductionAccountFence(client)
      await exerciseProductionAuthorityInterlocks(pool, client)
      await exerciseLineage(client)
      await exerciseSandboxVoidAfterCredentialRotation(client)
      for (const [table, trigger] of [
        [
          'operations_carrier_rate_test_labels',
          'validate_operations_carrier_shipping_diagnostic_label',
        ],
        [
          'operations_carrier_rate_test_label_attempts',
          'validate_operations_carrier_shipping_diagnostic_attempt',
        ],
        [
          'operations_carrier_rate_test_label_attempts',
          'maintain_operations_carrier_shipping_diagnostic_authority_lease',
        ],
        [
          'operations_activation_scopes',
          'protect_operations_carrier_shipping_diagnostic_activation',
        ],
        [
          'operations_integration_accounts',
          'protect_operations_carrier_shipping_diagnostic_integration',
        ],
        [
          'operations_carrier_credentials',
          'protect_operations_carrier_shipping_diagnostic_credential',
        ],
        [
          'operations_carrier_accounts',
          'protect_operations_carrier_shipping_diagnostic_account',
        ],
      ]) {
        await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
      }
      await client.query('SET session_replication_role = origin')
      await assertMutatedDeferredTriggerFailsAttestation(client)
      await assertMutatedOneOffTriggerFailsAttestation(client)
      await assertMutatedAccountServiceIndexFailsAttestation(client)
      await assertMutatedDiagnosticFenceIndexesFailAttestation(client)
      await assertMutatedDiagnosticAuthorityTriggerFailsAttestation(client)
      await assertMutatedFunctionBodyFailsAttestation(client)
      await assertMutatedOneOffFunctionBodyFailsAttestation(client)
      await assertMutatedDiagnosticAuthorityBodyFailsAttestation(client)
    } finally {
      client.release()
    }
    console.log(
      `Carrier shipping diagnostic PostgreSQL acceptance passed (${migration}).`,
    )
  } finally {
    if (pool) await pool.end().catch(() => {})
    spawnSync('docker', ['rm', '--force', containerName], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'ignore',
    })
  }
}

await main()
