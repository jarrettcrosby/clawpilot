#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const root = process.cwd()
const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    env: { ...process.env, ...options.env },
  })
  if (result.error || result.status !== 0) {
    throw result.error || new Error(
      `${binary} ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
    )
  }
  return String(result.stdout || '').trim()
}

function migrations() {
  return readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right))
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000
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
    } catch {
      await pool.end().catch(() => undefined)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error('Disposable PostgreSQL did not become ready')
}

async function applyMigration(client, filename) {
  const sql = readFileSync(resolve(root, 'db/migrations', filename), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query(
      'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    )
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum)
       VALUES ($1, $2)`,
      [filename, createHash('sha256').update(sql).digest('hex')],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw new Error(`Migration ${filename} failed`, { cause: error })
  }
}

async function rejected(work, pattern, message) {
  let error = null
  try {
    await work()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, `${message}: expected rejection`)
  assert.match(String(error.message || error), pattern, message)
  return error
}

async function rejectedInSavepoint(client, work, pattern, message) {
  await client.query('SAVEPOINT fixture_expected_rejection')
  let error
  try {
    error = await rejected(work, pattern, message)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT fixture_expected_rejection')
    await client.query('RELEASE SAVEPOINT fixture_expected_rejection')
  }
  return error
}

async function seedAuthority(pool) {
  const fixedOrganizationId = 'c6c8e6e7-fffa-4969-9526-e99da0ab2754'
  const owner = `fixture-owner-${randomUUID()}@example.test`
  const inactiveAdmin = `fixture-admin-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO app_users (email, role, status)
     VALUES ($1, 'owner', 'active'), ($2, 'admin', 'active')`,
    [owner, inactiveAdmin],
  )
  const organization = await pool.query(
    `INSERT INTO workspace_organizations (
       id, name, organization_type, created_by, updated_by
     ) VALUES (
       $2::uuid, 'Shopify reversal fixture acceptance', 'root', $1, $1
     )
     RETURNING id::text`,
    [owner, fixedOrganizationId],
  )
  const organizationId = organization.rows[0].id
  await pool.query(
    `INSERT INTO app_user_organization_memberships (
       user_email, organization_id, role, permissions, status, is_default,
       created_by, updated_by
     ) VALUES
       ($1, $3::uuid, 'owner', '{}'::jsonb, 'active', true, $1, $1),
       ($2, $3::uuid, 'admin', '{}'::jsonb, 'disabled', false, $1, $1)`,
    [owner, inactiveAdmin, organizationId],
  )
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (
       'deployment.database.identity',
       '{"id":"750aa268-0e31-4065-a99c-4016e4d4fab1"}'::jsonb,
       now()
     )
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = EXCLUDED.updated_at`,
  )
  await pool.query(
    `INSERT INTO crm_reference_number_registry (number_value, allocated_at)
     VALUES ('h34fedoa5b1o', now())`,
  )
  await pool.query(
    `INSERT INTO crm_reference_registry (
       reference_code, prefix, canonical_code, status, allocated_at,
       entity_type
     ) SELECT
       'giah34fedoa5b1o', 'gia', 'giah34fedoa5b1o', 'active', now(),
       entity_type
     FROM global_reference_entity_types
     WHERE prefix = 'gia'`,
  )
  const account = await pool.query(
    `INSERT INTO operations_integration_accounts (
       global_id, organization_id, provider, integration_type, environment,
       display_name, status, configuration, external_account_id,
       commerce_credential_generation, created_by, updated_by
     ) VALUES (
       'giah34fedoa5b1o', $1::uuid, 'shopify', 'commerce', 'sandbox',
       'Fixed reversal development store', 'active',
       '{
         "shopDomain":"test-pro-bakery-bites.myshopify.com",
         "authMode":"shopify_client_credentials",
         "grantedScopes":[
           "read_orders",
           "write_merchant_managed_fulfillment_orders",
           "write_orders"
         ]
       }'::jsonb,
       'gid://shopify/Shop/95083757815', 1, $2, $2
     ) RETURNING id::text`,
    [organizationId, owner],
  )
  const accountId = account.rows[0].id
  await pool.query(
    `INSERT INTO operations_commerce_credentials (
       organization_id, integration_account_id, external_account_id,
       auth_mode, credential_ciphertext, credential_iv, credential_tag,
       credential_version, credential_identifier_last_four,
       verification_status, verified_at, webhook_verification_status,
       created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, 'gid://shopify/Shop/95083757815',
       'shopify_client_credentials', decode('01', 'hex'),
       decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'),
       1, '6789', 'verified', now(), 'unverified', $3, $3
     )`,
    [organizationId, accountId, owner],
  )
  await pool.query(
    `INSERT INTO operations_commerce_provider_write_controls (
       organization_id, integration_account_id, provider, row_version,
       expected_row_version, requested_mode, bound_credential_generation,
       bound_granted_scopes, bound_granted_scope_digest, changed_by,
       changed_role, idempotency_key, request_hash
     ) VALUES (
       $1::uuid, $2::uuid, 'shopify', 1, 0, 'on', 1,
       ARRAY[
         'read_orders',
         'write_merchant_managed_fulfillment_orders',
         'write_orders'
       ]::text[],
       operations_commerce_granted_scope_digest(ARRAY[
         'read_orders',
         'write_merchant_managed_fulfillment_orders',
         'write_orders'
       ]::text[]),
       $3, 'owner', $4, repeat('9', 64)
     )`,
    [
      organizationId,
      accountId,
      owner,
      `fixture-provider-writes-${randomUUID()}`,
    ],
  )
  const control = await pool.query(
    `SELECT row_version::text,
            bound_granted_scope_digest
     FROM operations_commerce_provider_write_control_current
     WHERE organization_id = $1::uuid
       AND integration_account_id = $2::uuid`,
    [organizationId, accountId],
  )
  const session = await pool.query(
    `INSERT INTO app_sessions (
       token_hash, authenticated_user_email, effective_user_email,
       auth_method, device_label, idle_timeout_seconds,
       idle_expires_at, absolute_expires_at,
       active_workspace_organization_id
     ) VALUES (
       $1, $2, $2, 'magic_code', 'Fixture acceptance browser', 3600,
       now() + interval '1 hour', now() + interval '8 hours', $3::uuid
     ) RETURNING id::text`,
    [
      createHash('sha256').update(randomUUID()).digest('hex'),
      owner,
      organizationId,
    ],
  )
  return {
    owner,
    inactiveAdmin,
    organizationId,
    accountId,
    sessionId: session.rows[0].id,
    controlRowVersion: Number(control.rows[0].row_version),
    scopeDigest: control.rows[0].bound_granted_scope_digest,
  }
}

async function insertOrderCommand(pool, fixture, options = {}) {
  const global = await pool.query(
    `SELECT allocate_global_reference('gsfc') AS global_id`,
  )
  const globalId = global.rows[0].global_id
  const sourceIdentifier = `clawpilot-reversal-fixture:${globalId}`
  const uniqueTag = `clawpilot-reversal-${createHash('sha256')
    .update(`${globalId}:${randomUUID()}`)
    .digest('hex').slice(0, 24)}`
  const intentHash = createHash('sha256')
    .update(`intent:${globalId}`)
    .digest('hex')
  const confirmationHash = createHash('sha256')
    .update(`CREATE TEST ORDER ${intentHash.slice(0, 12)}`)
    .digest('hex')
  const providerPayloadHash = options.providerPayloadHash
    || createHash('sha256')
      .update(`provider-payload:${globalId}`)
      .digest('hex')
  const expiresAt = new Date(Date.now() + (options.expiresInMs || 300_000))
    .toISOString()
  const inserted = await pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_commands (
       global_id, organization_id, integration_account_id,
       phase, fixture_profile_version, prepared_by, prepared_role,
       idempotency_key, intent_hash, confirmation_hash,
       provider_payload_hash,
       provider_write_control_row_version, credential_generation,
       granted_scope_digest, external_account_id, shop_domain,
       source_identifier, unique_tag, tag_fingerprint, expires_at
     ) VALUES (
       $1, $2::uuid, $3::uuid,
       'create_order', 'shopify-reversal-fixture-v2', $4, $5,
       $6, $7, $8,
       $9,
       $10::bigint, 1, $11, 'gid://shopify/Shop/95083757815',
       'test-pro-bakery-bites.myshopify.com',
       $12, $13,
       encode(digest(convert_to($13, 'UTF8'), 'sha256'), 'hex'),
       $14::timestamptz
     ) RETURNING id::text, global_id, intent_hash, confirmation_hash,
                 provider_payload_hash`,
    [
      globalId,
      fixture.organizationId,
      fixture.accountId,
      options.actor || fixture.owner,
      options.role || 'owner',
      `fixture-command-${randomUUID()}`,
      intentHash,
      confirmationHash,
      providerPayloadHash,
      fixture.controlRowVersion,
      fixture.scopeDigest,
      sourceIdentifier,
      uniqueTag,
      expiresAt,
    ],
  )
  return inserted.rows[0]
}

async function insertApproval(pool, fixture, command, options = {}) {
  return pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_approvals (
       organization_id, command_id, approved_by, approved_role,
       browser_session_id, intent_hash, confirmation_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7
     ) RETURNING id::text, global_id, approved_at`,
    [
      fixture.organizationId,
      command.id,
      options.actor || fixture.owner,
      options.role || 'owner',
      options.sessionId || fixture.sessionId,
      options.intentHash || command.intent_hash,
      options.confirmationHash || command.confirmation_hash,
    ],
  )
}

async function insertAttempt(pool, fixture, command, approvalId, options = {}) {
  return pool.query(
    `INSERT INTO operations_shopify_reversal_fixture_attempts (
       organization_id, command_id, approval_id, phase,
       claimed_by, claimed_role, intent_hash, confirmation_hash,
       worker_principal
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'create_order',
       $4, $5, $6, $7, $8
     ) RETURNING id::text, global_id`,
    [
      fixture.organizationId,
      command.id,
      approvalId,
      options.actor || fixture.owner,
      options.role || 'owner',
      options.intentHash || command.intent_hash,
      options.confirmationHash || command.confirmation_hash,
      options.workerPrincipal || 'pipeline_outbox_worker',
    ],
  )
}

async function insertOutcome(
  queryable,
  fixture,
  command,
  attemptId,
  state,
  evidence = 'a'.repeat(64),
  providerErrorSummary = null,
) {
  const reconciled = state.startsWith('reconciled_')
  const unknown = state === 'unknown'
  const rejectedOutcome = state === 'rejected'
  const succeeded = state === 'succeeded'
  return queryable.query(
    `INSERT INTO operations_shopify_reversal_fixture_outcomes (
       organization_id, command_id, attempt_id, outcome_state,
       provider_mutation_attempted, provider_writes, error_code,
       provider_error_summary, evidence_hash, recorded_by
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5, $6::integer, $7, $8, $9, $10
     ) RETURNING id::text, global_id, outcome_state`,
    [
      fixture.organizationId,
      command.id,
      attemptId,
      state,
      reconciled ? false : true,
      unknown ? null : succeeded ? 1 : 0,
      unknown
        ? 'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN'
        : rejectedOutcome
          ? 'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED'
          : null,
      providerErrorSummary,
      unknown ? null : evidence,
      fixture.owner,
    ],
  )
}

async function exercise(pool) {
  const fixture = await seedAuthority(pool)
  await rejected(
    () => insertOrderCommand(pool, fixture, {
      actor: fixture.inactiveAdmin,
      role: 'admin',
    }),
    /command is not currently authorized/iu,
    'inactive administrator cannot prepare',
  )

  const short = await insertOrderCommand(pool, fixture, { expiresInMs: 1500 })
  const awaiting = await pool.query(
    `SELECT state, approval_global_id
     FROM operations_shopify_reversal_fixture_command_state
     WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
    [fixture.organizationId, short.id],
  )
  assert.equal(awaiting.rows[0].state, 'awaiting_approval')
  assert.equal(awaiting.rows[0].approval_global_id, null)
  await rejected(
    () => insertApproval(pool, fixture, short, { sessionId: randomUUID() }),
    /human approval is not currently authorized/iu,
    'approval requires the exact current authenticated browser session',
  )
  await pool.query(
    `UPDATE app_sessions
     SET revoked_at = now(), revoked_reason = 'fixture-test'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await rejected(
    () => insertApproval(pool, fixture, short),
    /human approval is not currently authorized/iu,
    'a revoked browser session cannot approve',
  )
  await pool.query(
    `UPDATE app_sessions SET revoked_at = NULL, revoked_reason = NULL
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await pool.query(
    `UPDATE app_sessions SET idle_expires_at = now() - interval '1 second'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await rejected(
    () => insertApproval(pool, fixture, short),
    /human approval is not currently authorized/iu,
    'an idle-expired browser session cannot approve',
  )
  await pool.query(
    `UPDATE app_sessions SET idle_expires_at = now() + interval '1 hour'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await pool.query(
    `UPDATE app_sessions
     SET created_at = now() - interval '2 hours',
         absolute_expires_at = now() - interval '1 hour'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await rejected(
    () => insertApproval(pool, fixture, short),
    /human approval is not currently authorized/iu,
    'an absolute-expired browser session cannot approve',
  )
  await pool.query(
    `UPDATE app_sessions
     SET created_at = now(), absolute_expires_at = now() + interval '8 hours'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await pool.query(
    `UPDATE app_sessions
     SET effective_user_email = $2,
         impersonation_started_at = now(),
         impersonation_expires_at = now() + interval '30 minutes'
     WHERE id = $1::uuid`,
    [fixture.sessionId, fixture.inactiveAdmin],
  )
  await rejected(
    () => insertApproval(pool, fixture, short),
    /human approval is not currently authorized/iu,
    'an impersonated browser session cannot approve',
  )
  await pool.query(
    `UPDATE app_sessions
     SET effective_user_email = $2,
         impersonation_started_at = NULL,
         impersonation_expires_at = NULL
     WHERE id = $1::uuid`,
    [fixture.sessionId, fixture.owner],
  )
  await rejected(
    () => insertApproval(pool, fixture, short, {
      intentHash: '0'.repeat(64),
    }),
    /human approval is not currently authorized/iu,
    'approval remains bound to the exact command intent',
  )
  const shortApproval = await insertApproval(pool, fixture, short)
  const approvedState = await pool.query(
    `SELECT state, approval_global_id, approved_by
     FROM operations_shopify_reversal_fixture_command_state
     WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
    [fixture.organizationId, short.id],
  )
  assert.equal(approvedState.rows[0].state, 'prepared')
  assert.equal(
    approvedState.rows[0].approval_global_id,
    shortApproval.rows[0].global_id,
  )
  assert.equal(approvedState.rows[0].approved_by, fixture.owner)
  await rejected(
    () => pool.query(
      `UPDATE operations_shopify_reversal_fixture_approvals
       SET approved_at = now()
       WHERE id = $1::uuid`,
      [shortApproval.rows[0].id],
    ),
    /ledgers are append-only/iu,
    'human approvals are immutable',
  )
  await rejected(
    () => insertApproval(pool, fixture, short),
    /duplicate key/iu,
    'an exact approval replay cannot append a second approval',
  )
  await rejected(
    () => insertOrderCommand(pool, fixture),
    /command is not currently authorized/iu,
    'a second live phase-1 command is serialized and rejected',
  )
  await pool.query('SELECT pg_sleep(1.55)')
  const expiredApproval = await pool.query(
    `SELECT operations_shopify_reversal_fixture_approval_is_current(
       $1::uuid, $2::uuid, $3::uuid
     ) AS current`,
    [fixture.organizationId, short.id, shortApproval.rows[0].id],
  )
  assert.equal(
    expiredApproval.rows[0].current,
    false,
    'approval expiry must be rechecked at provider-action time',
  )
  await rejected(
    () => insertAttempt(
      pool,
      fixture,
      short,
      shortApproval.rows[0].id,
    ),
    /provider claim is not currently authorized/iu,
    'an approved command cannot be claimed after its action window expires',
  )
  const prepared = await insertOrderCommand(pool, fixture)
  assert.notEqual(prepared.global_id, short.global_id)

  await rejected(
    () => pool.query(
      `UPDATE operations_shopify_reversal_fixture_commands
       SET expires_at = now() + interval '1 hour'
       WHERE id = $1::uuid`,
      [prepared.id],
    ),
    /ledgers are append-only/iu,
    'prepared commands are immutable',
  )
  await rejected(
    () => insertAttempt(pool, fixture, prepared, randomUUID(), {
      confirmationHash: '0'.repeat(64),
    }),
    /provider claim is not currently authorized/iu,
    'worker execution cannot self-confirm without durable human approval',
  )

  const approval = await insertApproval(pool, fixture, prepared)

  await pool.query(
    `UPDATE app_user_organization_memberships
     SET status = 'disabled'
     WHERE organization_id = $1::uuid AND user_email = $2`,
    [fixture.organizationId, fixture.owner],
  )
  await rejected(
    () => insertAttempt(pool, fixture, prepared, approval.rows[0].id),
    /provider claim is not currently authorized/iu,
    'active membership is rechecked at claim',
  )
  await pool.query(
    `UPDATE app_user_organization_memberships
     SET status = 'active'
     WHERE organization_id = $1::uuid AND user_email = $2`,
    [fixture.organizationId, fixture.owner],
  )
  await pool.query(
    `UPDATE app_users SET status = 'disabled' WHERE email = $1`,
    [fixture.owner],
  )
  await rejected(
    () => insertAttempt(pool, fixture, prepared, approval.rows[0].id),
    /provider claim is not currently authorized/iu,
    'active application-user status is rechecked at claim',
  )
  await pool.query(
    `UPDATE app_users SET status = 'active' WHERE email = $1`,
    [fixture.owner],
  )
  await rejected(
    () => insertAttempt(pool, fixture, prepared, approval.rows[0].id, {
      workerPrincipal: 'untrusted_worker',
    }),
    /provider claim is not currently authorized|worker_principal/iu,
    'only the exact fixture worker principal can claim',
  )
  const attempt = await insertAttempt(
    pool,
    fixture,
    prepared,
    approval.rows[0].id,
  )
  await rejected(
    () => insertAttempt(pool, fixture, prepared, approval.rows[0].id),
    /duplicate key/iu,
    'a claimed provider attempt cannot be retried',
  )

  const attemptId = attempt.rows[0].id
  const currentClaim = async (phase, payloadHash, actor = fixture.owner) => {
    const result = await pool.query(
      `SELECT operations_shopify_reversal_fixture_provider_claim_is_current(
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6
       ) AS current`,
      [
        fixture.organizationId,
        prepared.id,
        attemptId,
        actor,
        phase,
        payloadHash,
      ],
    )
    return result.rows[0].current
  }
  assert.equal(
    await currentClaim('create_order', prepared.provider_payload_hash),
    true,
    'the exact immutable phase and provider payload are current',
  )
  assert.equal(
    await currentClaim('create_fulfillment', prepared.provider_payload_hash),
    false,
    'a create-order claim cannot cross into fulfillment',
  )
  assert.equal(
    await currentClaim('create_order', 'f'.repeat(64)),
    false,
    'a substituted provider payload is not authorized',
  )
  await pool.query(
    `UPDATE app_sessions
     SET revoked_at = now(), revoked_reason = 'post-claim-revocation'
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  assert.equal(
    await currentClaim('create_order', prepared.provider_payload_hash),
    false,
    'session revocation after claim closes the final provider fence',
  )
  await pool.query(
    `UPDATE app_sessions SET revoked_at = NULL, revoked_reason = NULL
     WHERE id = $1::uuid`,
    [fixture.sessionId],
  )
  await rejected(
    () => pool.query(
      `INSERT INTO operations_shopify_reversal_fixture_outcomes (
         organization_id, command_id, attempt_id, outcome_state,
         provider_mutation_attempted, provider_writes, error_code, recorded_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'rejected', true, 1,
         'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED', $4
       )`,
      [fixture.organizationId, prepared.id, attemptId, fixture.owner],
    ),
    /shape_valid/iu,
    'an explicit provider rejection cannot claim a confirmed provider write',
  )
  const processing = await pool.query(
    `SELECT state, initial_outcome_global_id,
            reconciliation_outcome_global_id
     FROM operations_shopify_reversal_fixture_command_state
     WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
    [fixture.organizationId, prepared.id],
  )
  assert.equal(processing.rows[0].state, 'processing')
  assert.equal(processing.rows[0].initial_outcome_global_id, null)
  assert.equal(processing.rows[0].reconciliation_outcome_global_id, null)
  await rejected(
    () => insertOutcome(
      pool,
      fixture,
      prepared,
      attemptId,
      'reconciled_absent',
    ),
    /outcome is not authorized/iu,
    'an outcome-less claim cannot reconcile while dispatch may be in flight',
  )

  await pool.query(
    `ALTER TABLE operations_shopify_reversal_fixture_commands
     DISABLE TRIGGER immutable_shopify_reversal_fixture_commands`,
  )
  try {
    await pool.query(
      `UPDATE operations_shopify_reversal_fixture_commands
       SET prepared_at = now() - interval '2 minutes',
           expires_at = now() - interval '31 seconds'
       WHERE organization_id = $1::uuid AND id = $2::uuid`,
      [fixture.organizationId, prepared.id],
    )
  } finally {
    await pool.query(
      `ALTER TABLE operations_shopify_reversal_fixture_commands
       ENABLE TRIGGER immutable_shopify_reversal_fixture_commands`,
    )
  }

  for (const reconciledState of [
    'reconciled_applied',
    'reconciled_absent',
    'reconciled_ambiguous',
  ]) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const outcome = await insertOutcome(
        client,
        fixture,
        prepared,
        attemptId,
        reconciledState,
      )
      const state = await client.query(
        `SELECT state, initial_outcome_global_id,
                reconciliation_outcome_global_id
         FROM operations_shopify_reversal_fixture_command_state
         WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
        [fixture.organizationId, prepared.id],
      )
      assert.equal(state.rows[0].state, reconciledState)
      assert.equal(state.rows[0].initial_outcome_global_id, null)
      assert.equal(
        state.rows[0].reconciliation_outcome_global_id,
        outcome.rows[0].global_id,
      )
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  }

  const lateInitialClient = await pool.connect()
  try {
    await lateInitialClient.query('BEGIN')
    await insertOutcome(
      lateInitialClient,
      fixture,
      prepared,
      attemptId,
      'reconciled_absent',
    )
    await rejected(
      () => insertOutcome(
        lateInitialClient,
        fixture,
        prepared,
        attemptId,
        'succeeded',
      ),
      /outcome is not authorized/iu,
      'a late initial outcome cannot contradict outcome-less reconciliation',
    )
    await lateInitialClient.query('ROLLBACK')
  } finally {
    lateInitialClient.release()
  }

  const unknownClient = await pool.connect()
  try {
    await unknownClient.query('BEGIN')
    const safeProviderErrorSummary =
      'Shopify rejected order creation (INVALID at order.lineItems.0.variantId)'
    await unknownClient.query('SAVEPOINT fixture_valid_rejected_summary')
    await insertOutcome(
      unknownClient,
      fixture,
      prepared,
      attemptId,
      'rejected',
      'e'.repeat(64),
      safeProviderErrorSummary,
    )
    const rejectedState = await unknownClient.query(
      `SELECT provider_error_code, provider_error_summary
       FROM operations_shopify_reversal_fixture_command_state
       WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
      [fixture.organizationId, prepared.id],
    )
    assert.equal(
      rejectedState.rows[0].provider_error_code,
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_REJECTED',
    )
    assert.equal(
      rejectedState.rows[0].provider_error_summary,
      safeProviderErrorSummary,
    )
    await unknownClient.query('ROLLBACK TO SAVEPOINT fixture_valid_rejected_summary')
    await unknownClient.query('RELEASE SAVEPOINT fixture_valid_rejected_summary')
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'succeeded',
        'e'.repeat(64),
        safeProviderErrorSummary,
      ),
      /shopify_reversal_fixture_outcomes_provider_error_summary_valid/iu,
      'successful outcomes cannot retain a provider error summary',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'reconciled_absent',
        'e'.repeat(64),
        safeProviderErrorSummary,
      ),
      /shopify_reversal_fixture_outcomes_provider_error_summary_valid/iu,
      'non-provider reconciliation cannot retain a provider error summary',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'unknown',
        'e'.repeat(64),
        `${safeProviderErrorSummary}\nunsafe`,
      ),
      /shopify_reversal_fixture_outcomes_provider_error_summary_valid/iu,
      'provider error summaries must be printable single-line evidence',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'rejected',
        'e'.repeat(64),
        'A printable raw Shopify message must not be retained',
      ),
      /shopify_reversal_fixture_outcomes_provider_error_summary_valid/iu,
      'provider error summaries must match the safe code and field grammar',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'unknown',
        'e'.repeat(64),
        'x'.repeat(501),
      ),
      /shopify_reversal_fixture_outcomes_provider_error_summary_valid/iu,
      'provider error summaries are bounded to 500 characters',
    )
    await insertOutcome(
      unknownClient,
      fixture,
      prepared,
      attemptId,
      'unknown',
      'e'.repeat(64),
      safeProviderErrorSummary,
    )
    await insertOutcome(
      unknownClient,
      fixture,
      prepared,
      attemptId,
      'reconciled_absent',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOutcome(
        unknownClient,
        fixture,
        prepared,
        attemptId,
        'reconciled_absent',
        'b'.repeat(64),
      ),
      /duplicate key/iu,
      'one read-reconciliation outcome is append-only',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => insertOrderCommand(unknownClient, fixture),
      /command is not currently authorized/iu,
      'an unknown provider write is never retried after reconciliation',
    )
    await rejectedInSavepoint(
      unknownClient,
      () => unknownClient.query(
        `DELETE FROM operations_shopify_reversal_fixture_outcomes
         WHERE organization_id = $1::uuid AND attempt_id = $2::uuid`,
        [fixture.organizationId, attemptId],
      ),
      /ledgers are append-only/iu,
      'outcome evidence cannot be deleted',
    )
    const state = await unknownClient.query(
      `SELECT state, attempt_global_id, reconciliation_outcome_global_id,
              provider_error_code, provider_error_summary
       FROM operations_shopify_reversal_fixture_command_state
       WHERE organization_id = $1::uuid AND command_id = $2::uuid`,
      [fixture.organizationId, prepared.id],
    )
    assert.equal(state.rows[0].state, 'reconciled_absent')
    assert.equal(state.rows[0].attempt_global_id, attempt.rows[0].global_id)
    assert.ok(state.rows[0].reconciliation_outcome_global_id)
    assert.equal(
      state.rows[0].provider_error_code,
      'SHOPIFY_REVERSAL_FIXTURE_ORDER_OUTCOME_UNKNOWN',
    )
    assert.equal(
      state.rows[0].provider_error_summary,
      safeProviderErrorSummary,
    )
    await unknownClient.query('ROLLBACK')
  } finally {
    unknownClient.release()
  }

  const race = await Promise.allSettled([
    insertOutcome(
      pool,
      fixture,
      prepared,
      attemptId,
      'succeeded',
      'c'.repeat(64),
    ),
    insertOutcome(
      pool,
      fixture,
      prepared,
      attemptId,
      'reconciled_absent',
      'd'.repeat(64),
    ),
  ])
  assert.equal(
    race.filter((result) => result.status === 'fulfilled').length,
    1,
    'advisory serialization must allow exactly one race outcome',
  )
  assert.equal(
    race.filter((result) => result.status === 'rejected').length,
    1,
    'the contradictory race outcome must be rejected',
  )
  const raceRows = await pool.query(
    `SELECT outcome_state
     FROM operations_shopify_reversal_fixture_outcomes
     WHERE organization_id = $1::uuid AND attempt_id = $2::uuid`,
    [fixture.organizationId, attemptId],
  )
  assert.equal(raceRows.rows.length, 1)
  assert.ok([
    'succeeded',
    'reconciled_absent',
  ].includes(raceRows.rows[0].outcome_state))
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const postgresImage = String(
    process.env.SHOPIFY_REVERSAL_FIXTURE_POSTGRES_IMAGE
      || 'pgvector/pgvector:pg16',
  ).trim()
  const container = `clawpilot-shopify-reversal-${randomUUID()}`
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=postgres',
      '-e', 'POSTGRES_DB=clawpilot_shopify_reversal_test',
      '-p', '127.0.0.1::5432', postgresImage,
    ])
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = portOutput.match(/:(\d+)$/u)?.[1]
    assert.ok(port, `Unable to parse disposable PostgreSQL port: ${portOutput}`)
    const databaseUrl =
      `postgresql://postgres:postgres@127.0.0.1:${port}/clawpilot_shopify_reversal_test`
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 8 })
    try {
      for (const filename of migrations()) {
        await applyMigration(pool, filename)
      }
      await exercise(pool)
    } finally {
      await pool.end()
    }
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }
  console.log(
    `Shopify reversal fixture PostgreSQL ledger fences passed (${postgresImage}).`,
  )
}

await main()
