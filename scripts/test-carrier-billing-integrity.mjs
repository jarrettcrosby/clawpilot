#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromApp = createRequire(new URL('../app_src/package.json', import.meta.url))
const { Pool } = requireFromApp('pg')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function compactSql(source) {
  return source
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw result.error || new Error(
      `${commandName} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`,
    )
  }
  return String(result.stdout || '').trim()
}

async function waitForPostgres(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000 })
  const deadline = Date.now() + 60_000
  let lastError
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch (error) {
        lastError = error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
      }
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
  throw lastError || new Error('Disposable PostgreSQL did not become ready')
}

async function expectRejected(work, pattern, message) {
  let error
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, message)
  if (pattern) {
    assert.match(String(error.message || error), pattern, message)
  }
}

function verifySourceContracts() {
  const migration = compactSql(
    read('db/migrations/0092_operations_carrier_billing_integrity.sql'),
  )

  for (const fragment of [
    'CREATE OR REPLACE VIEW operations_carrier_account_identities AS',
    'account.account_number_fingerprint',
    'Carrier account ownership and non-secret account identity are immutable',
    'operations_carrier_billing_account_resolutions_exact_account_fkey',
    'operations_carrier_billing_matches_provenance_valid',
    'Matched shipment was not tendered with the billed carrier account',
    'operations_carrier_billing_shipper_assignments_provenance_valid',
    "assignment_source = 'manual'",
    "assignment_source = 'routing_rule'",
    'routing_rule_evidence ? \'requestChecksum\'',
    'Carrier billing shipper assignment must supersede the current decision',
    'operations_gl_coding_run_items_rule_version_fkey',
    "source_type = 'shipper_assignment'",
    "cost_basis = 'billed_actual'",
    "cost_basis = 'quoted_pro_forma'",
    'ALTER COLUMN quote_snapshot_id DROP NOT NULL',
    "settlement_type = 'platform_fee' AND amount_minor >= 0",
    'CREATE CONSTRAINT TRIGGER require_operations_triangle_platform_fee_write',
    'Square-to-circle quote requires exactly one Triangle platform fee settlement',
  ]) {
    assert.ok(
      migration.includes(fragment),
      `Missing carrier billing integrity SQL contract: ${fragment}`,
    )
  }
}

async function insertReturningId(pool, sql, params = []) {
  const result = await pool.query(sql, params)
  assert.equal(result.rowCount, 1)
  return result.rows[0]
}

async function seedCarrierBillingFixture(pool) {
  const suffix = randomBytes(4).toString('hex')
  const actorEmail = `carrier-integrity-${suffix}@example.com`
  const fingerprintA = 'a'.repeat(64)
  const fingerprintB = 'b'.repeat(64)
  const checksumA = '1'.repeat(64)
  const checksumB = '2'.repeat(64)

  await pool.query(
    `INSERT INTO app_users (email, role, status, display_name)
     VALUES ($1, 'owner', 'active', 'Carrier Integrity Owner')`,
    [actorEmail],
  )

  const triangle = await insertReturningId(
    pool,
    `INSERT INTO workspace_organizations (
       name, organization_type, created_by, updated_by
     ) VALUES ($1, 'root', $2, $2)
     RETURNING id, reference_code`,
    [`Triangle ${suffix}`, actorEmail],
  )
  const square = await insertReturningId(
    pool,
    `INSERT INTO workspace_organizations (
       parent_id, name, organization_type, created_by, updated_by
     ) VALUES ($1, $2, 'member', $3, $3)
     RETURNING id, reference_code`,
    [triangle.id, `Square ${suffix}`, actorEmail],
  )

  await pool.query(
    `UPDATE app_users
     SET organization_id = $2, organization_name = $3
     WHERE email = $1`,
    [actorEmail, square.id, `Square ${suffix}`],
  )

  const pipeline = await insertReturningId(
    pool,
    `INSERT INTO pipeline_spaces (
       name, owner_email, is_default, workspace_organization_id
     ) VALUES ($1, $2, true, $3)
     RETURNING id`,
    [`Carrier integrity ${suffix}`, actorEmail, square.id],
  )
  const circle = await insertReturningId(
    pool,
    `INSERT INTO crm_organizations (
       pipeline_id, source_key, name, identity_key,
       workspace_organization_id, relationship_type,
       source_hash, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $2,
       $4, 'customer',
       $2, $5, $5
     )
     RETURNING id, reference_code`,
    [
      pipeline.id,
      `circle-${suffix}`,
      `Circle ${suffix}`,
      square.id,
      actorEmail,
    ],
  )

  const commerceIntegration = await insertReturningId(
    pool,
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, created_by, updated_by
     ) VALUES ($1, 'test_commerce', 'commerce', 'sandbox', $2, $3, $3)
     RETURNING id`,
    [square.id, `Commerce ${suffix}`, actorEmail],
  )
  const carrierIntegration = await insertReturningId(
    pool,
    `INSERT INTO operations_integration_accounts (
       organization_id, provider, integration_type, environment,
       display_name, created_by, updated_by
     ) VALUES ($1, 'ups_rest', 'carrier', 'sandbox', $2, $3, $3)
     RETURNING id`,
    [square.id, `UPS ${suffix}`, actorEmail],
  )

  const network = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_networks (
       platform_organization_id, name, created_by, updated_by
     ) VALUES ($1, $2, $3, $3)
     RETURNING id`,
    [triangle.id, `Triangle Square Circle ${suffix}`, actorEmail],
  )
  const triangleParty = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_parties (
       network_id, role, entity_type, workspace_organization_id,
       display_name, created_by
     ) VALUES (
       $1, 'platform_operator', 'workspace_organization', $2, $3, $4
     )
     RETURNING id`,
    [network.id, triangle.id, `Triangle ${suffix}`, actorEmail],
  )
  const squareParty = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_parties (
       network_id, role, entity_type, workspace_organization_id,
       display_name, created_by
     ) VALUES (
       $1, 'reseller', 'workspace_organization', $2, $3, $4
     )
     RETURNING id`,
    [network.id, square.id, `Square ${suffix}`, actorEmail],
  )
  const circleParty = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_parties (
       network_id, role, entity_type, crm_pipeline_id, crm_customer_id,
       display_name, created_by
     ) VALUES (
       $1, 'shipper', 'crm_customer', $2, $3, $4, $5
     )
     RETURNING id`,
    [network.id, pipeline.id, circle.id, `Circle ${suffix}`, actorEmail],
  )

  async function createCarrierAccount(name, lastFour, fingerprint) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_accounts (
         organization_id, integration_account_id, display_name,
         account_number_ciphertext, account_number_iv, account_number_tag,
         account_number_last_four, account_number_fingerprint,
         registered_address, registered_address_fingerprint,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8,
         $9::jsonb, $10,
         $11, $11
       )
       RETURNING id, global_id`,
      [
        square.id,
        carrierIntegration.id,
        name,
        `ciphertext-${lastFour}`,
        `iv-${lastFour}`,
        `tag-${lastFour}`,
        lastFour,
        fingerprint,
        JSON.stringify({
          line1: '101 Carrier Way',
          city: 'Delaware',
          region: 'OH',
          postalCode: '43015',
          countryCode: 'US',
        }),
        checksumA,
        actorEmail,
      ],
    )
  }

  const accountA = await createCarrierAccount(`UPS A ${suffix}`, '1001', fingerprintA)
  const accountB = await createCarrierAccount(`UPS B ${suffix}`, '2002', fingerprintB)

  async function createAuthorization(account) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_account_authorizations (
         network_id, account_owner_organization_id, integration_account_id,
         carrier_account_id, allow_rating, allow_labels, allow_tracking,
         authorized_by, approved_by
       ) VALUES (
         $1, $2, $3,
         $4, true, true, true,
         $5, $5
       )
       RETURNING id`,
      [network.id, square.id, carrierIntegration.id, account.id, actorEmail],
    )
  }

  const authorizationA = await createAuthorization(accountA)
  const authorizationB = await createAuthorization(accountB)

  const rootGrant = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_grants (
       network_id, account_authorization_id,
       grantor_party_id, grantee_party_id,
       allow_rating, allow_labels, allow_tracking,
       allow_regrant, max_descendant_depth,
       created_by, approved_by
     ) VALUES (
       $1, $2,
       $3, $4,
       true, true, true,
       true, 2,
       $5, $5
     )
     RETURNING id`,
    [
      network.id,
      authorizationA.id,
      triangleParty.id,
      squareParty.id,
      actorEmail,
    ],
  )
  const platformDirective = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rate_directives (
       network_id, grant_id, beneficiary_party_id,
       directive_type, calculation_basis, amount_minor,
       priority, created_by, approved_by
     ) VALUES (
       $1, $2, $3,
       'fixed_amount', 'quoted_cost', 0,
       10, $4, $4
     )
     RETURNING id`,
    [network.id, rootGrant.id, triangleParty.id, actorEmail],
  )

  const warehouse = await insertReturningId(
    pool,
    `INSERT INTO operations_warehouses (
       organization_id, code, name, address, created_by, updated_by
     ) VALUES ($1, $2, $3, '{}'::jsonb, $4, $4)
     RETURNING id`,
    [square.id, `WH-${suffix}`, `Warehouse ${suffix}`, actorEmail],
  )
  const order = await insertReturningId(
    pool,
    `INSERT INTO operations_orders (
       organization_id, pipeline_id, customer_id, integration_account_id,
       source_provider, external_order_id, order_number, status,
       ship_to, created_by, updated_by
     ) VALUES (
       $1, $2, $3, $4,
       'test_commerce', $5, $6, 'planned',
       $7::jsonb, $8, $8
     )
     RETURNING id`,
    [
      square.id,
      pipeline.id,
      circle.id,
      commerceIntegration.id,
      `external-${suffix}`,
      `ORDER-${suffix}`,
      JSON.stringify({
        name: 'Circle Receiver',
        line1: '200 Customer Lane',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
      }),
      actorEmail,
    ],
  )
  const plan = await insertReturningId(
    pool,
    `INSERT INTO operations_fulfillment_plans (
       organization_id, order_id, warehouse_id, method,
       promised_delivery_at, created_by
     ) VALUES (
       $1, $2, $3, 'manual_override',
       now() + interval '5 days', $4
     )
     RETURNING id`,
    [square.id, order.id, warehouse.id, actorEmail],
  )
  const packageRow = await insertReturningId(
    pool,
    `INSERT INTO operations_packages (
       organization_id, plan_id, package_number,
       length_mm, width_mm, height_mm, weight_grams,
       status, packed_by, packed_at
     ) VALUES (
       $1, $2, 1,
       200, 150, 100, 1000,
       'labeled', $3, now()
     )
     RETURNING id`,
    [square.id, plan.id, actorEmail],
  )
  const rate = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_rates (
       organization_id, plan_id, carrier, service_code, service_name,
       internal_cost_minor, customer_charge_minor, transit_days,
       estimated_delivery_at, meets_promise, selected
     ) VALUES (
       $1, $2, 'UPS', 'GROUND', 'UPS Ground',
       1000, 1100, 3,
       now() + interval '3 days', true, true
     )
     RETURNING id`,
    [square.id, plan.id],
  )

  return {
    actorEmail,
    suffix,
    fingerprintA,
    fingerprintB,
    checksumA,
    checksumB,
    triangle,
    square,
    circle,
    pipeline,
    commerceIntegration,
    carrierIntegration,
    network,
    triangleParty,
    squareParty,
    circleParty,
    accountA,
    accountB,
    authorizationA,
    authorizationB,
    rootGrant,
    platformDirective,
    warehouse,
    order,
    plan,
    packageRow,
    rate,
  }
}

async function createZeroFeeQuoteAndShipment(pool, fixture) {
  const client = await pool.connect()
  let quote
  try {
    await client.query('BEGIN')
    quote = await insertReturningId(
      client,
      `INSERT INTO operations_carrier_quote_snapshots (
         executing_organization_id, network_id,
         account_authorization_id, account_owner_organization_id,
         integration_account_id, carrier_account_id,
         order_id, package_id, shipper_party_id,
         carrier_rate_id, platform_directive_id,
         carrier, service_code, provider_quote_id,
         quoted_carrier_cost_minor, customer_charge_minor,
         platform_fee_minor, reseller_fee_minor, currency,
         party_path_snapshot, grant_path_snapshot,
         directive_snapshot, pricing_snapshot,
         request_hash, idempotency_key, quoted_at,
         actor_email, billing_relationship, billing_selection_snapshot
       ) VALUES (
         $1, $2,
         $3, $1,
         $4, $5,
         $6, $7, $8,
         $9, $10,
         'UPS', 'GROUND', $11,
         1000, 1100,
         0, 100, 'USD',
         $12::jsonb, $13::jsonb,
         $14::jsonb, $15::jsonb,
         $16, $17, now(),
         $18, 'sender', $19::jsonb
       )
       RETURNING id, global_id`,
      [
        fixture.square.id,
        fixture.network.id,
        fixture.authorizationA.id,
        fixture.carrierIntegration.id,
        fixture.accountA.id,
        fixture.order.id,
        fixture.packageRow.id,
        fixture.circleParty.id,
        fixture.rate.id,
        fixture.platformDirective.id,
        `provider-quote-${fixture.suffix}`,
        JSON.stringify([
          { id: fixture.triangleParty.id, role: 'platform_operator' },
          { id: fixture.squareParty.id, role: 'reseller' },
          { id: fixture.circleParty.id, role: 'shipper' },
        ]),
        JSON.stringify([{ id: fixture.rootGrant.id }]),
        JSON.stringify([{ id: fixture.platformDirective.id, amountMinor: 0 }]),
        JSON.stringify({ platformFee: 0, resellerFee: 100 }),
        fixture.checksumA,
        `quote-${fixture.suffix}`,
        fixture.actorEmail,
        JSON.stringify({ relationship: 'sender', carrierAccountId: fixture.accountA.id }),
      ],
    )

    await client.query(
      `INSERT INTO operations_settlement_entries (
         network_id, quote_snapshot_id, executing_organization_id,
         account_authorization_id, carrier_account_id,
         settlement_type,
         payer_type, payer_party_id,
         payee_type, payee_party_id,
         amount_minor, currency, source_type, source_global_id,
         cost_basis, idempotency_key, actor_email
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         'platform_fee',
         'rate_party', $6,
         'rate_party', $7,
         0, 'USD', 'quote_snapshot', $8,
         'quoted_pro_forma', $9, $10
       )`,
      [
        fixture.network.id,
        quote.id,
        fixture.square.id,
        fixture.authorizationA.id,
        fixture.accountA.id,
        fixture.circleParty.id,
        fixture.triangleParty.id,
        quote.global_id,
        `platform-fee-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }

  const label = await insertReturningId(
    pool,
    `INSERT INTO operations_labels (
       organization_id, package_id, carrier_rate_id,
       carrier, service_code, tracking_number,
       format, label_payload, provider_label_id, idempotency_key
     ) VALUES (
       $1, $2, $3,
       'UPS', 'GROUND', '1ZTEST001',
       'ZPL', '^XA^XZ', $4, $5
     )
     RETURNING id`,
    [
      fixture.square.id,
      fixture.packageRow.id,
      fixture.rate.id,
      `provider-label-${fixture.suffix}`,
      `label-${fixture.suffix}`,
    ],
  )
  const shipment = await insertReturningId(
    pool,
    `INSERT INTO operations_shipments (
       organization_id, order_id, plan_id, package_id, label_id,
       status, tracking_number, quoted_carrier_cost_minor,
       rate_quote_snapshot_id, carrier_cost_status, confirmed_by
     ) VALUES (
       $1, $2, $3, $4, $5,
       'confirmed', '1ZTEST001', 1000,
       $6, 'quoted', $7
     )
     RETURNING id`,
    [
      fixture.square.id,
      fixture.order.id,
      fixture.plan.id,
      fixture.packageRow.id,
      label.id,
      quote.id,
      fixture.actorEmail,
    ],
  )

  return { quote, label, shipment }
}

async function verifyMissingPlatformFeeRejected(pool, fixture) {
  await expectRejected(
    async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO operations_carrier_quote_snapshots (
             executing_organization_id, network_id,
             account_authorization_id, account_owner_organization_id,
             integration_account_id, carrier_account_id,
             order_id, package_id, shipper_party_id,
             carrier_rate_id, platform_directive_id,
             carrier, service_code, provider_quote_id,
             quoted_carrier_cost_minor, customer_charge_minor,
             platform_fee_minor, reseller_fee_minor, currency,
             party_path_snapshot, grant_path_snapshot,
             directive_snapshot, pricing_snapshot,
             request_hash, idempotency_key, quoted_at,
             actor_email
           ) VALUES (
             $1, $2,
             $3, $1,
             $4, $5,
             $6, $7, $8,
             $9, $10,
             'UPS', 'GROUND', $11,
             1000, 1100,
             0, 100, 'USD',
             $12::jsonb, '[{}]'::jsonb,
             '[{}]'::jsonb, '{"platformFee":0}'::jsonb,
             $13, $14, now(),
             $15
           )`,
          [
            fixture.square.id,
            fixture.network.id,
            fixture.authorizationA.id,
            fixture.carrierIntegration.id,
            fixture.accountA.id,
            fixture.order.id,
            fixture.packageRow.id,
            fixture.circleParty.id,
            fixture.rate.id,
            fixture.platformDirective.id,
            `missing-fee-${fixture.suffix}`,
            JSON.stringify([
              { role: 'platform_operator' },
              { role: 'reseller' },
              { role: 'shipper' },
            ]),
            fixture.checksumB,
            `missing-fee-${fixture.suffix}`,
            fixture.actorEmail,
          ],
        )
        try {
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        }
      } finally {
        client.release()
      }
    },
    /requires exactly one Triangle platform fee settlement/,
    'Square-to-circle quote without Triangle fee participation must fail',
  )
}

async function createBillingEvidence(pool, fixture) {
  const batch = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_batches (
       network_id, importing_organization_id,
       provider, environment, source_format,
       source_filename, source_checksum,
       imported_by
     ) VALUES (
       $1, $2,
       'UPS', 'sandbox', 'csv',
       $3, $4,
       $5
     )
     RETURNING id`,
    [
      fixture.network.id,
      fixture.square.id,
      `ups-${fixture.suffix}.csv`,
      '3'.repeat(64),
      fixture.actorEmail,
    ],
  )

  async function createStatement(externalId, maskedReference, fingerprint) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_billing_statements (
         network_id, batch_id, external_statement_id,
         billed_account_masked_reference, billed_account_fingerprint,
         statement_period_start, statement_period_end,
         currency, finalized, evidence_snapshot
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         current_date - 30, current_date,
         'USD', true, '{}'::jsonb
       )
       RETURNING id`,
      [fixture.network.id, batch.id, externalId, maskedReference, fingerprint],
    )
  }

  const statementA = await createStatement(
    `statement-a-${fixture.suffix}`,
    '****1001',
    fixture.fingerprintA,
  )
  const statementB = await createStatement(
    `statement-b-${fixture.suffix}`,
    '****2002',
    fixture.fingerprintB,
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_account_resolutions (
         network_id, statement_id, decision,
         account_authorization_id, account_owner_organization_id,
         integration_account_id, carrier_account_id,
         match_method, confidence_basis_points, decided_by
       ) VALUES (
         $1, $2, 'matched',
         $3, $4,
         $5, $6,
         'account_fingerprint', 10000, $7
       )`,
      [
        fixture.network.id,
        statementA.id,
        fixture.authorizationB.id,
        fixture.square.id,
        fixture.carrierIntegration.id,
        fixture.accountB.id,
        fixture.actorEmail,
      ],
    ),
    /Billed account fingerprint does not match/,
    'Statement account fingerprint must select the exact carrier account',
  )

  async function createResolution(statement, authorization, account) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_billing_account_resolutions (
         network_id, statement_id, decision,
         account_authorization_id, account_owner_organization_id,
         integration_account_id, carrier_account_id,
         match_method, confidence_basis_points, decided_by
       ) VALUES (
         $1, $2, 'matched',
         $3, $4,
         $5, $6,
         'account_fingerprint', 10000, $7
       )
       RETURNING
         id, provider_snapshot, environment_snapshot,
         account_number_fingerprint_snapshot`,
      [
        fixture.network.id,
        statement.id,
        authorization.id,
        fixture.square.id,
        fixture.carrierIntegration.id,
        account.id,
        fixture.actorEmail,
      ],
    )
  }

  const resolutionA = await createResolution(
    statementA,
    fixture.authorizationA,
    fixture.accountA,
  )
  const resolutionB = await createResolution(
    statementB,
    fixture.authorizationB,
    fixture.accountB,
  )

  assert.equal(resolutionA.provider_snapshot, 'ups_rest')
  assert.equal(resolutionA.environment_snapshot, 'sandbox')
  assert.equal(
    resolutionA.account_number_fingerprint_snapshot,
    fixture.fingerprintA,
  )
  assert.equal(
    resolutionB.account_number_fingerprint_snapshot,
    fixture.fingerprintB,
  )

  const statementCount = await pool.query(
    `SELECT count(*)::integer AS count
     FROM operations_carrier_billing_statements
     WHERE batch_id = $1`,
    [batch.id],
  )
  assert.equal(statementCount.rows[0].count, 2)

  async function createCharge(statement, externalId, sourceHash, tracking, amount, sequence) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_billing_charges (
         network_id, statement_id, external_charge_id,
         source_row_hash, tracking_number, provider_label_id,
         service_code, charge_category, description,
         amount_minor, currency, line_sequence,
         routing_attributes, raw_evidence
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         'GROUND', 'transportation', $3,
         $7, 'USD', $8,
         '{}'::jsonb, '{}'::jsonb
       )
       RETURNING id`,
      [
        fixture.network.id,
        statement.id,
        externalId,
        sourceHash,
        tracking,
        `provider-label-${fixture.suffix}`,
        amount,
        sequence,
      ],
    )
  }

  const matchedCharge = await createCharge(
    statementA,
    `matched-${fixture.suffix}`,
    '4'.repeat(64),
    '1Z TEST-001',
    1500,
    1,
  )
  const manualCharge = await createCharge(
    statementA,
    `manual-${fixture.suffix}`,
    '5'.repeat(64),
    '1Z ORPHAN-A',
    2500,
    2,
  )
  const ruleCharge = await createCharge(
    statementB,
    `rule-${fixture.suffix}`,
    '6'.repeat(64),
    '1Z ORPHAN-B',
    3000,
    1,
  )

  return {
    batch,
    statementA,
    statementB,
    resolutionA,
    resolutionB,
    matchedCharge,
    manualCharge,
    ruleCharge,
  }
}

async function createMatchAndAssignmentEvidence(pool, fixture, shipmentEvidence, billing) {
  const exactMatchParams = [
    fixture.network.id,
    billing.matchedCharge.id,
    fixture.square.id,
    shipmentEvidence.shipment.id,
    fixture.packageRow.id,
    shipmentEvidence.label.id,
    billing.resolutionA.id,
    fixture.authorizationA.id,
    fixture.accountA.id,
    shipmentEvidence.quote.id,
    fixture.actorEmail,
  ]

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_matches (
         network_id, charge_id, decision,
         executing_organization_id, shipment_id, package_id, label_id,
         account_resolution_id, account_authorization_id,
         carrier_account_id, quote_snapshot_id,
         match_method, confidence_basis_points, decided_by
       ) VALUES (
         $1, $2, 'matched',
         $3, $4, $5, $6,
         $7, $8,
         $9, $10,
         'tracking_number', 10000, $11
       )`,
      [
        fixture.network.id,
        billing.matchedCharge.id,
        fixture.square.id,
        shipmentEvidence.shipment.id,
        fixture.packageRow.id,
        shipmentEvidence.label.id,
        billing.resolutionB.id,
        fixture.authorizationB.id,
        fixture.accountB.id,
        shipmentEvidence.quote.id,
        fixture.actorEmail,
      ],
    ),
    /current exact account resolution/,
    'Shipment match cannot borrow another statement account resolution',
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_matches (
         network_id, charge_id, decision,
         executing_organization_id, shipment_id, package_id, label_id,
         account_resolution_id, account_authorization_id,
         carrier_account_id, quote_snapshot_id,
         match_method, confidence_basis_points, decided_by
       ) VALUES (
         $1, $2, 'matched',
         $3, $4, $5, $6,
         $7, $8,
         $9, $10,
         'tracking_number', 10000, $11
       )`,
      [
        fixture.network.id,
        billing.manualCharge.id,
        fixture.square.id,
        shipmentEvidence.shipment.id,
        fixture.packageRow.id,
        shipmentEvidence.label.id,
        billing.resolutionA.id,
        fixture.authorizationA.id,
        fixture.accountA.id,
        shipmentEvidence.quote.id,
        fixture.actorEmail,
      ],
    ),
    /tracking number does not exactly match/,
    'Shipment match requires exact canonical tracking evidence',
  )

  const exactMatch = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_matches (
       network_id, charge_id, decision,
       executing_organization_id, shipment_id, package_id, label_id,
       account_resolution_id, account_authorization_id,
       carrier_account_id, quote_snapshot_id,
       match_method, confidence_basis_points, decided_by
     ) VALUES (
       $1, $2, 'matched',
       $3, $4, $5, $6,
       $7, $8,
       $9, $10,
       'tracking_number', 10000, $11
     )
     RETURNING
       id, billing_statement_id, provider_identity_snapshot,
       tracking_number_snapshot, billed_account_fingerprint_snapshot`,
    exactMatchParams,
  )
  assert.equal(exactMatch.billing_statement_id, billing.statementA.id)
  assert.equal(exactMatch.provider_identity_snapshot, 'ups')
  assert.equal(exactMatch.tracking_number_snapshot, '1ZTEST001')
  assert.equal(
    exactMatch.billed_account_fingerprint_snapshot,
    fixture.fingerprintA,
  )

  async function createUnmatchedDecision(charge, reason) {
    return insertReturningId(
      pool,
      `INSERT INTO operations_carrier_billing_matches (
         network_id, charge_id, decision,
         match_method, confidence_basis_points,
         reason, decided_by
       ) VALUES (
         $1, $2, 'unmatched',
         'none', 10000,
         $3, $4
       )
       RETURNING id, billing_statement_id`,
      [fixture.network.id, charge.id, reason, fixture.actorEmail],
    )
  }

  const manualUnmatched = await createUnmatchedDecision(
    billing.manualCharge,
    'No ClawPilot shipment has this tracking number',
  )
  const ruleUnmatched = await createUnmatchedDecision(
    billing.ruleCharge,
    'No ClawPilot shipment has this tracking number',
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_shipper_assignments (
         network_id, charge_id, decision, shipper_party_id,
         assignment_source, manual_assignment_evidence,
         routing_rule_evidence, reason, decided_by
       ) VALUES (
         $1, $2, 'assigned', $3,
         'manual', '{"reviewed":true}'::jsonb,
         '{"requestChecksum":"${fixture.checksumA}"}'::jsonb,
         'Reviewed orphan charge', $4
       )`,
      [
        fixture.network.id,
        billing.manualCharge.id,
        fixture.circleParty.id,
        fixture.actorEmail,
      ],
    ),
    /shipper_assignments_provenance_valid/,
    'Manual and routing-rule assignment evidence must be mutually exclusive',
  )

  const manualAssignment = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_shipper_assignments (
       network_id, charge_id, decision, shipper_party_id,
       assignment_source, manual_assignment_evidence,
       reason, decided_by, coding_outputs
     ) VALUES (
       $1, $2, 'assigned', $3,
       'manual', $4::jsonb,
       $5, $6, $7::jsonb
     )
     RETURNING id, global_id`,
    [
      fixture.network.id,
      billing.manualCharge.id,
      fixture.circleParty.id,
      JSON.stringify({ reviewed: true, chargeId: billing.manualCharge.id }),
      'Operator assigned an unmatched carrier charge',
      fixture.actorEmail,
      JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
    ],
  )

  const routingRule = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_routing_rules (
       network_id, name, priority, match_mode,
       conditions, outputs, target_shipper_party_id,
       version_number, status, effective_from,
       created_by, approved_by, idempotency_key, request_checksum
     ) VALUES (
       $1, $2, 10, 'all',
       $3::jsonb, $4::jsonb, $5,
       1, 'active', now() - interval '1 minute',
       $6, $6, $7, $8
     )
     RETURNING id, version_number`,
    [
      fixture.network.id,
      `Route orphan B ${fixture.suffix}`,
      JSON.stringify({ billedAccountFingerprint: fixture.fingerprintB }),
      JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
      fixture.circleParty.id,
      fixture.actorEmail,
      `route-v1-${fixture.suffix}`,
      fixture.checksumA,
    ],
  )

  await expectRejected(
    () => pool.query(
      `UPDATE operations_carrier_billing_routing_rules
       SET conditions = '{"changed":true}'::jsonb
       WHERE id = $1`,
      [routingRule.id],
    ),
    /append-only/,
    'Routing-rule versions must be immutable',
  )

  const glRun = await insertReturningId(
    pool,
    `INSERT INTO operations_gl_coding_runs (
       network_id, selection_snapshot, rule_snapshot,
       input_checksum, idempotency_key,
       selected_batch_count, selected_charge_count,
       requested_by
     ) VALUES (
       $1, '{"provider":"UPS","environment":"sandbox"}'::jsonb,
       $2::jsonb,
       $3, $4,
       1, 1,
       $5
     )
     RETURNING id`,
    [
      fixture.network.id,
      JSON.stringify([{ id: routingRule.id, version: 1 }]),
      fixture.checksumB,
      `gl-run-${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO operations_gl_coding_run_batches (
       network_id, run_id, batch_id
     ) VALUES ($1, $2, $3)`,
    [fixture.network.id, glRun.id, billing.batch.id],
  )
  await pool.query(
    `UPDATE operations_gl_coding_runs
     SET status = 'running', started_at = now()
     WHERE id = $1`,
    [glRun.id],
  )

  const routingAssignment = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_shipper_assignments (
       network_id, charge_id, decision, shipper_party_id,
       assignment_source, routing_rule_id, routing_rule_version,
       gl_coding_run_id, coding_outputs,
       routing_rule_evidence, routing_rule_request_checksum,
       service_actor
     ) VALUES (
       $1, $2, 'assigned', $3,
       'routing_rule', $4, 1,
       $5, $6::jsonb,
       $7::jsonb, $8,
       'carrier-billing-integrity-test'
     )
     RETURNING id`,
    [
      fixture.network.id,
      billing.ruleCharge.id,
      fixture.circleParty.id,
      routingRule.id,
      glRun.id,
      JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
      JSON.stringify({
        requestChecksum: fixture.checksumA,
        evaluation: { matched: true, fields: ['billedAccountFingerprint'] },
      }),
      fixture.checksumA,
    ],
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_shipper_assignments (
         network_id, charge_id, decision, shipper_party_id,
         assignment_source, routing_rule_id, routing_rule_version,
         gl_coding_run_id, coding_outputs,
         routing_rule_evidence, routing_rule_request_checksum,
         service_actor
       ) VALUES (
         $1, $2, 'assigned', $3,
         'routing_rule', $4, 1,
         $5, $6::jsonb,
         $7::jsonb, $8,
         'carrier-billing-integrity-test'
       )`,
      [
        fixture.network.id,
        billing.ruleCharge.id,
        fixture.circleParty.id,
        routingRule.id,
        glRun.id,
        JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
        JSON.stringify({
          requestChecksum: fixture.checksumA,
          evaluation: { matched: true },
        }),
        fixture.checksumA,
      ],
    ),
    /must supersede the current decision/,
    'Assignment lineage cannot create a second current branch',
  )

  await pool.query(
    `INSERT INTO operations_gl_coding_run_items (
       network_id, run_id, charge_id,
       billing_match_id, shipper_assignment_id,
       routing_rule_id, routing_rule_version,
       result, shipment_match_status, shipper_assignment_status,
       coding_outputs, evidence
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       $6, 1,
       'assigned', 'unmatched', 'assigned',
       $7::jsonb, $8::jsonb
     )`,
    [
      fixture.network.id,
      glRun.id,
      billing.ruleCharge.id,
      ruleUnmatched.id,
      routingAssignment.id,
      routingRule.id,
      JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
      JSON.stringify({ provenance: 'routing_rule' }),
    ],
  )

  const routingRuleV2 = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_routing_rules (
       network_id, name, priority, match_mode,
       conditions, outputs, target_shipper_party_id,
       version_number, supersedes_rule_id,
       status, effective_from,
       created_by, approved_by, idempotency_key, request_checksum
     )
     SELECT
       network_id, name, priority, match_mode,
       conditions, $2::jsonb, target_shipper_party_id,
       2, id,
       'active', now() - interval '1 second',
       $3, $3, $4, $5
     FROM operations_carrier_billing_routing_rules
     WHERE id = $1
     RETURNING id, version_number`,
    [
      routingRule.id,
      JSON.stringify({ glAccount: '6001', department: 'FREIGHT' }),
      fixture.actorEmail,
      `route-v2-${fixture.suffix}`,
      fixture.checksumB,
    ],
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_carrier_billing_routing_rules (
         network_id, name, priority, match_mode,
         conditions, outputs, target_shipper_party_id,
         version_number, supersedes_rule_id,
         status, effective_from,
         created_by, approved_by, idempotency_key, request_checksum
       )
       SELECT
         network_id, name, priority, match_mode,
         conditions, outputs, target_shipper_party_id,
         2, id,
         'active', now(),
         $2, $2, $3, $4
       FROM operations_carrier_billing_routing_rules
       WHERE id = $1`,
      [
        routingRule.id,
        fixture.actorEmail,
        `route-branch-${fixture.suffix}`,
        '7'.repeat(64),
      ],
    ),
    /must supersede the current immutable version/,
    'Routing-rule lineage cannot branch from an immutable prior version',
  )

  const routingAssignmentV2 = await insertReturningId(
    pool,
    `INSERT INTO operations_carrier_billing_shipper_assignments (
       network_id, charge_id, decision, shipper_party_id,
       assignment_source, routing_rule_id, routing_rule_version,
       gl_coding_run_id, coding_outputs,
       routing_rule_evidence, routing_rule_request_checksum,
       supersedes_assignment_id, service_actor
     ) VALUES (
       $1, $2, 'assigned', $3,
       'routing_rule', $4, 2,
       $5, $6::jsonb,
       $7::jsonb, $8,
       $9, 'carrier-billing-integrity-test'
     )
     RETURNING id`,
    [
      fixture.network.id,
      billing.ruleCharge.id,
      fixture.circleParty.id,
      routingRuleV2.id,
      glRun.id,
      JSON.stringify({ glAccount: '6001', department: 'FREIGHT' }),
      JSON.stringify({
        requestChecksum: fixture.checksumB,
        evaluation: { matched: true, superseded: routingAssignment.id },
      }),
      fixture.checksumB,
      routingAssignment.id,
    ],
  )

  const currentAssignment = await pool.query(
    `SELECT id
     FROM operations_carrier_billing_current_shipper_assignments
     WHERE network_id = $1 AND charge_id = $2`,
    [fixture.network.id, billing.ruleCharge.id],
  )
  assert.equal(currentAssignment.rowCount, 1)
  assert.equal(currentAssignment.rows[0].id, routingAssignmentV2.id)

  await expectRejected(
    () => pool.query(
      `UPDATE operations_carrier_billing_shipper_assignments
       SET reason = 'changed'
       WHERE id = $1`,
      [manualAssignment.id],
    ),
    /append-only/,
    'Shipper assignments must be immutable',
  )
  await expectRejected(
    () => pool.query(
      `UPDATE operations_carrier_accounts
       SET account_number_fingerprint = $2
       WHERE id = $1`,
      [fixture.accountA.id, '8'.repeat(64)],
    ),
    /non-secret account identity are immutable/,
    'Carrier account fingerprint identity must be immutable',
  )

  return {
    exactMatch,
    manualUnmatched,
    ruleUnmatched,
    manualAssignment,
    routingRule,
    routingRuleV2,
    glRun,
    routingAssignment,
    routingAssignmentV2,
  }
}

async function verifySettlementAndIdentityEvidence(
  pool,
  fixture,
  shipmentEvidence,
  billing,
  decisions,
) {
  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_settlement_entries (
         network_id, quote_snapshot_id, executing_organization_id,
         account_authorization_id, carrier_account_id,
         settlement_type,
         payer_type, payer_party_id,
         payee_type, payee_party_id,
         amount_minor, currency,
         source_type, source_global_id,
         idempotency_key, actor_email
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         'reseller_fee',
         'rate_party', $6,
         'rate_party', $7,
         100, 'USD',
         'quote_snapshot', $8,
         $9, $10
       )`,
      [
        fixture.network.id,
        shipmentEvidence.quote.id,
        fixture.square.id,
        fixture.authorizationA.id,
        fixture.accountA.id,
        fixture.circleParty.id,
        fixture.squareParty.id,
        shipmentEvidence.quote.global_id,
        `missing-basis-${fixture.suffix}`,
        fixture.actorEmail,
      ],
    ),
    /source_provenance_valid/,
    'Settlement cost basis cannot pass its CHECK as NULL',
  )

  const settlementParams = [
    fixture.network.id,
    fixture.square.id,
    fixture.authorizationA.id,
    fixture.accountA.id,
    billing.statementA.id,
    billing.manualCharge.id,
    billing.resolutionA.id,
    decisions.manualAssignment.id,
    fixture.circleParty.id,
    fixture.squareParty.id,
    decisions.manualAssignment.global_id,
    billing.manualCharge.id,
    fixture.actorEmail,
  ]

  const settlementReviewRun = await insertReturningId(
    pool,
    `INSERT INTO operations_gl_coding_runs (
       network_id, selection_snapshot, rule_snapshot,
       input_checksum, idempotency_key,
       selected_batch_count, selected_charge_count,
       requested_by
     ) VALUES (
       $1, $2::jsonb, '[]'::jsonb,
       $3, $4,
       1, 1,
       $5
     )
     RETURNING id`,
    [
      fixture.network.id,
      JSON.stringify({
        batches: [{ globalId: billing.batch.global_id }],
        purpose: 'settlement-integrity-review',
      }),
      fixture.checksumA,
      `settlement-review-run-${fixture.suffix}`,
      fixture.actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO operations_gl_coding_run_batches (
       network_id, run_id, batch_id
     ) VALUES ($1, $2, $3)`,
    [fixture.network.id, settlementReviewRun.id, billing.batch.id],
  )
  await pool.query(
    `UPDATE operations_gl_coding_runs
     SET status = 'running', started_at = now()
     WHERE id = $1`,
    [settlementReviewRun.id],
  )
  const settlementReviewRunItem = await insertReturningId(
    pool,
    `INSERT INTO operations_gl_coding_run_items (
       network_id, run_id, charge_id,
       billing_match_id, shipper_assignment_id,
       result, shipment_match_status, shipper_assignment_status,
       coding_outputs, evidence, explanation
     ) VALUES (
       $1, $2, $3,
       $4, $5,
       'assigned', 'unmatched', 'assigned',
       $6::jsonb, $7::jsonb, $8
     )
     RETURNING id`,
    [
      fixture.network.id,
      settlementReviewRun.id,
      billing.manualCharge.id,
      decisions.manualUnmatched.id,
      decisions.manualAssignment.id,
      JSON.stringify({ glAccount: '6000', department: 'FREIGHT' }),
      JSON.stringify({ assignmentSource: 'manual' }),
      'Manual assignment retained for billed-actual settlement review',
    ],
  )
  await pool.query(
    `UPDATE operations_gl_coding_runs
     SET status = 'completed',
         shipper_assigned_count = 1,
         completed_at = now(),
         summary = '{"assigned":1,"reviewReady":true}'::jsonb
     WHERE id = $1`,
    [settlementReviewRun.id],
  )
  const settlementReview = await insertReturningId(
    pool,
    `INSERT INTO operations_gl_coding_reviews (
       network_id, run_id, decision, reason,
       idempotency_key, evidence, reviewed_by
     ) VALUES (
       $1, $2, 'approved', $3,
       $4, $5::jsonb, $6
     )
     RETURNING id`,
    [
      fixture.network.id,
      settlementReviewRun.id,
      'Approved exact billed-actual evidence for settlement integrity tests',
      `settlement-review-${fixture.suffix}`,
      JSON.stringify({ purpose: 'settlement-integrity-review' }),
      fixture.actorEmail,
    ],
  )
  await pool.query(
    `INSERT INTO operations_gl_coding_review_items (
       network_id, run_id, review_id, run_item_id,
       billing_statement_id, billing_charge_id,
       billing_account_resolution_id, account_authorization_id,
       carrier_account_id, shipper_assignment_id,
       source_charge_amount_minor, currency, evidence
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6,
       $7, $8,
       $9, $10,
       $11, $12, $13::jsonb
     )`,
    [
      fixture.network.id,
      settlementReviewRun.id,
      settlementReview.id,
      settlementReviewRunItem.id,
      billing.statementA.id,
      billing.manualCharge.id,
      billing.resolutionA.id,
      fixture.authorizationA.id,
      fixture.accountA.id,
      decisions.manualAssignment.id,
      2500,
      'USD',
      JSON.stringify({
        codingOutputs: { glAccount: '6000', department: 'FREIGHT' },
      }),
    ],
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_settlement_entries (
         network_id, quote_snapshot_id, executing_organization_id,
         account_authorization_id, carrier_account_id,
         billing_statement_id, billing_charge_id,
         billing_account_resolution_id, shipper_assignment_id,
         settlement_type,
         payer_type, payer_party_id,
         payee_type, payee_party_id,
         amount_minor, currency,
         source_type, source_global_id,
         cost_basis, source_charge_amount_minor,
         idempotency_key, actor_email
       ) VALUES (
         $1, $14, $2,
         $3, $4,
         $5, $6,
         $7, $8,
         'rebill',
         'rate_party', $9,
         'rate_party', $10,
         2500, 'USD',
         'shipper_assignment', $11,
         'billed_actual', 2500,
         $12, $13
       )`,
      [
        ...settlementParams,
        shipmentEvidence.quote.id,
      ],
    ),
    /source_provenance_valid/,
    'Assignment settlement cannot fabricate quote provenance',
  )

  await expectRejected(
    () => pool.query(
      `INSERT INTO operations_settlement_entries (
         network_id, executing_organization_id,
         account_authorization_id, carrier_account_id,
         billing_statement_id, billing_charge_id,
         billing_account_resolution_id, shipper_assignment_id,
         settlement_type,
         payer_type, payer_party_id,
         payee_type, payee_party_id,
         amount_minor, currency,
         source_type, source_global_id,
         cost_basis, source_charge_amount_minor,
         idempotency_key, actor_email
       ) VALUES (
         $1, $2,
         $3, $4,
         $5, $6,
         $7, $8,
         'rebill',
         'rate_party', $9,
         'rate_party', $10,
         2500, 'USD',
         'shipper_assignment', $11,
         'billed_actual', 2499,
         $12, $13
       )`,
      settlementParams,
    ),
    /preserve the billed actual charge/,
    'Assignment settlement must preserve the signed billed actual amount',
  )

  const settlement = await insertReturningId(
    pool,
    `INSERT INTO operations_settlement_entries (
       network_id, executing_organization_id,
       account_authorization_id, carrier_account_id,
       billing_statement_id, billing_charge_id,
       billing_account_resolution_id, shipper_assignment_id,
       settlement_type,
       payer_type, payer_party_id,
       payee_type, payee_party_id,
       amount_minor, currency,
       source_type, source_global_id,
       cost_basis, source_charge_amount_minor,
       idempotency_key, actor_email
     ) VALUES (
       $1, $2,
       $3, $4,
       $5, $6,
       $7, $8,
       'rebill',
       'rate_party', $9,
       'rate_party', $10,
       2500, 'USD',
       'shipper_assignment', $11,
       'billed_actual', 2500,
       $12, $13
     )
     RETURNING
       id, quote_snapshot_id, cost_basis, source_charge_amount_minor`,
    settlementParams,
  )
  assert.equal(settlement.quote_snapshot_id, null)
  assert.equal(settlement.cost_basis, 'billed_actual')
  assert.equal(Number(settlement.source_charge_amount_minor), 2500)

  const insertSettlementEvent = async ({
    eventType,
    reason,
    reference,
    idempotencyKey,
  }) => insertReturningId(
    pool,
    `INSERT INTO operations_settlement_events (
       network_id, settlement_entry_id, event_type,
       details, idempotency_key, actor_email
     ) VALUES (
       $1, $2, $3,
       $4::jsonb, $5, $6
     )
     RETURNING id, global_id, event_type`,
    [
      fixture.network.id,
      settlement.id,
      eventType,
      JSON.stringify({
        reason,
        ...(reference ? { reference } : {}),
      }),
      idempotencyKey,
      fixture.actorEmail,
    ],
  )

  const approvedEvent = await insertSettlementEvent({
    eventType: 'approved',
    reason: 'Approved against exact carrier statement evidence',
    idempotencyKey: `settlement-approved-${fixture.suffix}`,
  })
  assert.equal(approvedEvent.event_type, 'approved')

  await expectRejected(
    () => insertSettlementEvent({
      eventType: 'billed',
      reason: 'Attempt billing without an external reference',
      idempotencyKey: `settlement-billed-no-ref-${fixture.suffix}`,
    }),
    /require an external reference/,
    'Billed settlement evidence must include an external reference',
  )

  const billedEvent = await insertSettlementEvent({
    eventType: 'billed',
    reason: 'Billed on the customer settlement statement',
    reference: `INV-${fixture.suffix}`,
    idempotencyKey: `settlement-billed-${fixture.suffix}`,
  })
  assert.equal(billedEvent.event_type, 'billed')

  const disputedEvent = await insertSettlementEvent({
    eventType: 'disputed',
    reason: 'Customer disputed the carrier accessorial',
    reference: `DSP-${fixture.suffix}`,
    idempotencyKey: `settlement-disputed-${fixture.suffix}`,
  })
  assert.equal(disputedEvent.event_type, 'disputed')

  const resolvedEvent = await insertSettlementEvent({
    eventType: 'resolved',
    reason: 'Carrier statement evidence resolved the dispute',
    reference: `DSP-${fixture.suffix}`,
    idempotencyKey: `settlement-resolved-${fixture.suffix}`,
  })
  assert.equal(resolvedEvent.event_type, 'resolved')

  const paidEvent = await insertSettlementEvent({
    eventType: 'paid',
    reason: 'Payment confirmed against remittance evidence',
    reference: `PAY-${fixture.suffix}`,
    idempotencyKey: `settlement-paid-${fixture.suffix}`,
  })
  assert.equal(paidEvent.event_type, 'paid')

  await expectRejected(
    () => insertSettlementEvent({
      eventType: 'reversed',
      reason: 'Attempt to reverse a completed payment',
      reference: `REV-${fixture.suffix}`,
      idempotencyKey: `settlement-reversed-after-paid-${fixture.suffix}`,
    }),
    /transition from paid to reversed is not allowed/,
    'Paid settlements require a new compensating entry instead of history mutation',
  )

  const currentSettlementStatus = await pool.query(
    `SELECT current_status, latest_event_global_id, latest_event_details
     FROM operations_settlement_current_status
     WHERE network_id = $1
       AND settlement_entry_id = $2`,
    [fixture.network.id, settlement.id],
  )
  assert.equal(currentSettlementStatus.rowCount, 1)
  assert.equal(currentSettlementStatus.rows[0].current_status, 'paid')
  assert.equal(
    currentSettlementStatus.rows[0].latest_event_global_id,
    paidEvent.global_id,
  )
  assert.equal(
    currentSettlementStatus.rows[0].latest_event_details.reference,
    `PAY-${fixture.suffix}`,
  )

  await expectRejected(
    () => pool.query(
      `UPDATE operations_settlement_events
       SET details = '{"reason":"mutated"}'::jsonb
       WHERE id = $1`,
      [approvedEvent.id],
    ),
    /append-only/,
    'Settlement lifecycle evidence must be immutable',
  )
  await expectRejected(
    () => pool.query(
      `DELETE FROM operations_settlement_events
       WHERE id = $1`,
      [approvedEvent.id],
    ),
    /append-only/,
    'Settlement lifecycle evidence cannot be deleted',
  )

  const financialBasis = await pool.query(
    `SELECT
       charge.amount_minor::text AS billed_actual,
       quote.quoted_carrier_cost_minor::text AS quoted_pro_forma,
       settlement.source_charge_amount_minor::text AS settlement_actual,
       settlement.quote_snapshot_id
     FROM operations_settlement_entries settlement
     JOIN operations_carrier_billing_charges charge
       ON charge.id = settlement.billing_charge_id
     CROSS JOIN operations_carrier_quote_snapshots quote
     WHERE settlement.id = $1
       AND quote.id = $2`,
    [settlement.id, shipmentEvidence.quote.id],
  )
  assert.deepEqual(financialBasis.rows[0], {
    billed_actual: '2500',
    quoted_pro_forma: '1000',
    settlement_actual: '2500',
    quote_snapshot_id: null,
  })

  const zeroFee = await pool.query(
    `SELECT amount_minor::text AS amount, cost_basis
     FROM operations_settlement_entries
     WHERE quote_snapshot_id = $1
       AND settlement_type = 'platform_fee'`,
    [shipmentEvidence.quote.id],
  )
  assert.equal(zeroFee.rowCount, 1)
  assert.deepEqual(zeroFee.rows[0], {
    amount: '0',
    cost_basis: 'quoted_pro_forma',
  })

  const identities = await pool.query(
    `SELECT id, account_number_last_four, account_number_fingerprint
     FROM operations_carrier_account_identities
     WHERE integration_account_id = $1
     ORDER BY account_number_last_four`,
    [fixture.carrierIntegration.id],
  )
  assert.equal(identities.rowCount, 2)
  assert.deepEqual(
    identities.rows.map((row) => row.account_number_last_four),
    ['1001', '2002'],
  )
  assert.deepEqual(
    identities.rows.map((row) => row.account_number_fingerprint),
    [fixture.fingerprintA, fixture.fingerprintB],
  )

  const secretColumns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'operations_carrier_account_identities'
       AND column_name IN (
         'account_number_ciphertext', 'account_number_iv',
         'account_number_tag', 'credential_reference',
         'registered_address'
       )`,
  )
  assert.equal(secretColumns.rowCount, 0)

  await pool.query(
    `UPDATE operations_gl_coding_runs
     SET
       status = 'completed',
       completed_at = now(),
       shipper_assigned_count = 1,
       summary = '{"assigned":1}'::jsonb
     WHERE id = $1`,
    [decisions.glRun.id],
  )
}

async function verifyPostgresAcceptance(connectionString) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 })
  try {
    const fixture = await seedCarrierBillingFixture(pool)
    const shipmentEvidence = await createZeroFeeQuoteAndShipment(pool, fixture)
    await verifyMissingPlatformFeeRejected(pool, fixture)
    const billing = await createBillingEvidence(pool, fixture)
    const decisions = await createMatchAndAssignmentEvidence(
      pool,
      fixture,
      shipmentEvidence,
      billing,
    )
    await verifySettlementAndIdentityEvidence(
      pool,
      fixture,
      shipmentEvidence,
      billing,
      decisions,
    )
  } finally {
    await pool.end()
  }
}

async function main() {
  verifySourceContracts()
  command('docker', ['info'], { timeout: 30_000 })

  const container = `clawpilot-carrier-integrity-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=clawpilot_carrier_integrity',
      '-e', 'POSTGRES_DB=clawpilot_carrier_integrity',
      '-p', '127.0.0.1::5432',
      'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(port > 0, `Unable to resolve disposable PostgreSQL port from ${portOutput}`)

    const connectionString =
      `postgresql://postgres:clawpilot_carrier_integrity@127.0.0.1:${port}/clawpilot_carrier_integrity`
    await waitForPostgres(connectionString)
    command('node', ['scripts/db-migrate.mjs'], {
      env: { DATABASE_URL: connectionString, PGSSLMODE: 'disable' },
      timeout: 240_000,
    })
    await verifyPostgresAcceptance(connectionString)
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  console.log('Carrier billing integrity PostgreSQL tests passed.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
