#!/usr/bin/env node

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  applyMigration,
  command,
  migrations,
  waitForPostgres,
} from './test-commerce-order-revisions-postgres.mjs'
import {
  OPERATIONS_CARRIER_WRITES_INDEPENDENT_ACTIVATION_FINGERPRINT_SQL,
  OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_FINGERPRINT_SQL,
  OPERATIONS_COMMERCE_ORDER_WORKBENCH_FINGERPRINT_SQL,
  OPERATIONS_ORDER_EDITING_RELEASE_HEALTH_SQL,
  OPERATIONS_ORDER_SHIPMENT_ADDRESS_FINGERPRINT_SQL,
  OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_ARTIFACT_COUNT,
  OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_ARTIFACT_HASH,
  OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_FINGERPRINT_SQL,
  OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_HEALTH_SQL,
  OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_FINGERPRINT_SQL,
} from '../app_src/lib/persistence/operationsOrderEditingReleaseHealth.ts'

const requireFromApp = createRequire(
  new URL('../app_src/package.json', import.meta.url),
)
const { Pool } = requireFromApp('pg')
const root = process.cwd()

async function health(client) {
  const result = await client.query(
    `SELECT (${OPERATIONS_ORDER_EDITING_RELEASE_HEALTH_SQL}) AS ready`,
  )
  return result.rows[0]?.ready === true
}

async function exactHistoryHealth(client) {
  const result = await client.query(
    `SELECT (${OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_HEALTH_SQL}) AS ready`,
  )
  return result.rows[0]?.ready === true
}

async function fingerprint(client, sql) {
  const result = await client.query(sql)
  return result.rows[0]
}

async function inRollback(client, action) {
  await client.query('BEGIN')
  try {
    await action()
  } finally {
    await client.query('ROLLBACK')
  }
}

async function verifyNegativeCases(client) {
  for (const filename of [
    '0307_operations_commerce_order_workbench.sql',
    '0308_operations_commerce_provider_write_controls.sql',
    '0310_operations_order_shipment_address_working_copy.sql',
    '0312_operations_shopify_order_single_save.sql',
    '0315_operations_carrier_writes_independent_activation.sql',
    '0325_operations_shopify_fulfillment_reversal.sql',
  ]) {
    await inRollback(client, async () => {
      await client.query(
        'DELETE FROM public.schema_migrations WHERE filename = $1',
        [filename],
      )
      assert.equal(
        await health(client),
        false,
        `Missing ${filename} ledger must fail health`,
      )
    })
    await inRollback(client, async () => {
      await client.query(
        `UPDATE public.schema_migrations
         SET checksum = $2
         WHERE filename = $1`,
        [filename, '0'.repeat(64)],
      )
      assert.equal(
        await health(client),
        false,
        `Wrong ${filename} checksum must fail health`,
      )
    })
  }

  await inRollback(client, async () => {
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = $2
       WHERE filename = $1`,
      [
        '0316_operations_commerce_fulfillment_authority_leases.sql',
        '0'.repeat(64),
      ],
    )
    assert.equal(
      await health(client),
      false,
      'Wrong 0316 checksum must fail health once the phase is installed',
    )
  })

  for (const statement of [
    `ALTER TABLE public.operations_commerce_order_workbench
       ADD COLUMN release_health_drift text`,
    `ALTER TABLE public.operations_commerce_provider_write_controls
       ADD COLUMN release_health_drift text`,
    `ALTER TABLE public.operations_order_shipment_address_working_copies
       ADD COLUMN release_health_drift text`,
  ]) {
    await inRollback(client, async () => {
      await client.query(statement)
      assert.equal(
        await health(client),
        false,
        'Order editing schema drift must fail health with intact ledgers',
      )
    })
  }

  await inRollback(client, async () => {
    await client.query(
      `ALTER FUNCTION
         public.operations_commerce_order_workbench_line_drafts_valid(jsonb)
       VOLATILE`,
    )
    assert.equal(
      await health(client),
      false,
      'Workbench function drift must fail health with an intact ledger',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `ALTER FUNCTION
         public.validate_operations_active_execution_prepare()
       SECURITY DEFINER`,
    )
    assert.equal(
      await health(client),
      false,
      'Carrier-write activation-independence function drift must fail health',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `ALTER FUNCTION
         public.operations_dispatch_address_core_fingerprint(jsonb)
       VOLATILE`,
    )
    assert.equal(
      await health(client),
      false,
      'Shipment-address function drift must fail health with an intact ledger',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `ALTER FUNCTION
         public.operations_commerce_granted_scope_snapshot(jsonb)
       VOLATILE`,
    )
    assert.equal(
      await health(client),
      false,
      'Provider-write function drift must fail health with intact ledgers',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `ALTER FUNCTION
         public.operations_commerce_fulfillment_authority_is_current(
           uuid, uuid, text, text, text, integer, jsonb, boolean
         )
       VOLATILE`,
    )
    assert.equal(
      await health(client),
      false,
      'Fulfillment-authority lease function drift must fail health',
    )
  })

  for (const statement of [
    `ALTER TABLE public.operations_commerce_order_workbench
       DISABLE TRIGGER validate_operations_commerce_order_workbench`,
    `ALTER TABLE public.operations_commerce_provider_write_controls
       DISABLE TRIGGER operations_commerce_provider_write_controls_validate`,
    `ALTER TABLE public.operations_order_shipment_address_working_copies
       DISABLE TRIGGER validate_operations_order_shipment_address_working_copy`,
    `ALTER TABLE public.operations_commerce_provider_attempts
       DISABLE TRIGGER maintain_commerce_fulfillment_authority_lease`,
  ]) {
    await inRollback(client, async () => {
      await client.query(statement)
      assert.equal(
        await health(client),
        false,
        'Order editing trigger drift must fail health with intact ledgers',
      )
    })
  }

  await inRollback(client, async () => {
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `INSERT INTO public.operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         lease_token, lease_expires_at, requested_at
       ) VALUES (
         $1::uuid, $2::uuid, 'shopify.fulfillment.create',
         'shopify-fulfillment-writeback-v2', 'gfe9999999', $3,
         repeat('a', 64), '{}'::jsonb, '{}'::jsonb, 'prepared', 1,
         $4::uuid, now() + interval '4 minutes', now()
       )`,
      [randomUUID(), randomUUID(), `health-invalid-${randomUUID()}`, randomUUID()],
    )
    assert.equal(
      await health(client),
      false,
      'A live prepared attempt without exact account authority must fail health',
    )
  })
  await inRollback(client, async () => {
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `INSERT INTO public.operations_commerce_provider_attempts (
         organization_id, integration_account_id, action, adapter_version,
         external_object_id, idempotency_key, request_hash,
         redacted_request, redacted_response, state, attempt_number,
         lease_token, lease_expires_at, requested_at
       ) VALUES (
         $1::uuid, $2::uuid, 'faire.fulfillment.shipments.create',
         'faire-fulfillment-writeback-v2', 'gfe9999998', $3,
         repeat('b', 64), '{}'::jsonb, '{}'::jsonb, 'prepared', 1,
         $4::uuid, now() + interval '6 minutes', now()
       )`,
      [randomUUID(), randomUUID(), `health-overlong-${randomUUID()}`, randomUUID()],
    )
    assert.equal(
      await health(client),
      false,
      'An overlong prepared fulfillment lease must fail health',
    )
  })
}

async function verifyExactHistoryNegativeCases(client) {
  for (const mutation of [
    {
      name: 'weakened returned-quantity constraint',
      sql: `
        ALTER TABLE public.operations_commerce_order_observation_lines
          DROP CONSTRAINT commerce_order_observation_line_returned_quantity_valid;
        ALTER TABLE public.operations_commerce_order_observation_lines
          ADD CONSTRAINT commerce_order_observation_line_returned_quantity_valid
          CHECK (true)
      `,
    },
    {
      name: 'weakened provider-line money constraint',
      sql: `
        ALTER TABLE public.operations_commerce_order_observation_lines
          DROP CONSTRAINT commerce_order_observation_line_money_valid;
        ALTER TABLE public.operations_commerce_order_observation_lines
          ADD CONSTRAINT commerce_order_observation_line_money_valid
          CHECK (true)
      `,
    },
    {
      name: 'weakened provider-line snapshot constraint',
      sql: `
        ALTER TABLE public.operations_commerce_order_observation_lines
          DROP CONSTRAINT commerce_order_observation_line_snapshots_valid;
        ALTER TABLE public.operations_commerce_order_observation_lines
          ADD CONSTRAINT commerce_order_observation_line_snapshots_valid
          CHECK (true)
      `,
    },
    {
      name: 'weakened tracking-URL constraint',
      sql: `
        ALTER TABLE public.operations_commerce_order_event_observations
          DROP CONSTRAINT commerce_order_event_tracking_url_valid;
        ALTER TABLE public.operations_commerce_order_event_observations
          ADD CONSTRAINT commerce_order_event_tracking_url_valid CHECK (true)
      `,
    },
    {
      name: 'unfiltered manual-read index',
      sql: `
        DROP INDEX public.idx_commerce_order_observation_manual_read;
        CREATE INDEX idx_commerce_order_observation_manual_read
          ON public.operations_commerce_order_observations (
            organization_id,
            integration_account_id,
            manual_provider_read_lease_id
          )
      `,
    },
    {
      name: 'disabled tracking-URL guard trigger',
      sql: `
        ALTER TABLE public.operations_commerce_order_event_observations
          DISABLE TRIGGER commerce_order_event_tracking_url_guard
      `,
    },
    {
      name: 'weakened tracking-URL guard function',
      sql: `
        CREATE OR REPLACE FUNCTION
          public.protect_commerce_order_event_tracking_url()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public, pg_temp
        AS $function$
        BEGIN
          RETURN NEW;
        END;
        $function$
      `,
    },
  ]) {
    await inRollback(client, async () => {
      await client.query(mutation.sql)
      assert.equal(
        await exactHistoryHealth(client),
        false,
        `${mutation.name} must fail exact-history health`,
      )
    })
  }

  await inRollback(client, async () => {
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = $2
       WHERE filename = $1`,
      [
        '0340_operations_order_workbench_exact_history.sql',
        '0'.repeat(64),
      ],
    )
    assert.equal(
      await exactHistoryHealth(client),
      false,
      'Wrong 0340 checksum must fail exact-history health',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = $2
       WHERE filename = $1`,
      [
        '0341_operations_faire_order_workbench_exact_history.sql',
        '0'.repeat(64),
      ],
    )
    assert.equal(
      await exactHistoryHealth(client),
      false,
      'Wrong 0341 checksum must fail exact-history health',
    )
  })
  await inRollback(client, async () => {
    await client.query(
      `UPDATE public.schema_migrations
       SET checksum = $2
       WHERE filename = $1`,
      [
        '0342_operations_order_history_line_fidelity.sql',
        '0'.repeat(64),
      ],
    )
    assert.equal(
      await exactHistoryHealth(client),
      false,
      'Wrong 0342 checksum must fail exact-history health',
    )
  })
}

async function main() {
  command('docker', ['info'], { timeout: 30_000 })
  const container = (
    `clawpilot-order-editing-health-${process.pid}-`
    + randomUUID().slice(0, 8)
  )
  try {
    command('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=order_editing_health',
      '-e', 'POSTGRES_DB=order_editing_health',
      '-p', '127.0.0.1::5432',
      process.env.CLAWPILOT_DISPOSABLE_POSTGRES_IMAGE
        || 'pgvector/pgvector:pg16',
    ], { timeout: 180_000 })
    const portOutput = command('docker', ['port', container, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/u)?.[1])
    assert.ok(port > 0, `Unable to resolve PostgreSQL port: ${portOutput}`)
    const databaseUrl = (
      'postgresql://postgres:order_editing_health@127.0.0.1:'
      + `${port}/order_editing_health`
    )
    await waitForPostgres(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, max: 1 })
    const client = await pool.connect()
    try {
      const files = migrations()
      const workbenchIndex = files.indexOf(
        '0307_operations_commerce_order_workbench.sql',
      )
      assert.ok(workbenchIndex > 0, '0307 order workbench migration is missing')
      for (const file of files.slice(0, workbenchIndex)) {
        await applyMigration(client, file)
      }
      assert.equal(
        await health(client),
        false,
        'The frozen pre-0307 phase must not satisfy current release health',
      )
      let exactHistoryInstalled = false
      for (const file of files.slice(workbenchIndex)) {
        await applyMigration(client, file)
        exactHistoryInstalled ||= (
          file ===
            '0348_operations_commerce_native_activity_evidence.sql'
        )
        if (!process.argv.includes('--print-fingerprints')) {
          assert.equal(
            await exactHistoryHealth(client),
            exactHistoryInstalled,
            exactHistoryInstalled
              ? `${file} must preserve exact-history health after 0348`
              : `${file} must not prematurely satisfy exact-history health`,
          )
        }
        if (
          file === '0307_operations_commerce_order_workbench.sql'
          || file === '0308_operations_commerce_provider_write_controls.sql'
          || file ===
            '0310_operations_order_shipment_address_working_copy.sql'
        ) {
          assert.equal(
            await health(client),
            false,
            `${file} alone must not satisfy current release health`,
          )
        }
        if (file === '0312_operations_shopify_order_single_save.sql') {
          assert.equal(
            await health(client),
            true,
            'The exact 0307/0308/0310/0312 phase must satisfy its health',
          )
        }
        if (
          file ===
            '0315_operations_carrier_writes_independent_activation.sql'
          && !process.argv.includes('--print-fingerprints')
        ) {
          assert.equal(
            await health(client),
            true,
            'The exact post-0315 carrier-write phase must satisfy health',
          )
        }
        if (file === '0325_operations_shopify_fulfillment_reversal.sql') {
          assert.equal(
            await health(client),
            true,
            'The exact post-0325 fulfillment-reversal phase must satisfy health',
          )
        }
      }
      const fingerprints = {
        workbench: await fingerprint(
          client,
          OPERATIONS_COMMERCE_ORDER_WORKBENCH_FINGERPRINT_SQL,
        ),
        providerWriteSingleSave: await fingerprint(
          client,
          OPERATIONS_PROVIDER_WRITE_SINGLE_SAVE_FINGERPRINT_SQL,
        ),
        shipmentAddress: await fingerprint(
          client,
          OPERATIONS_ORDER_SHIPMENT_ADDRESS_FINGERPRINT_SQL,
        ),
        carrierWritesIndependentActivation: await fingerprint(
          client,
          OPERATIONS_CARRIER_WRITES_INDEPENDENT_ACTIVATION_FINGERPRINT_SQL,
        ),
        commerceFulfillmentAuthorityLeases: await fingerprint(
          client,
          OPERATIONS_COMMERCE_FULFILLMENT_AUTHORITY_LEASES_FINGERPRINT_SQL,
        ),
        orderWorkbenchExactHistory: await fingerprint(
          client,
          OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_FINGERPRINT_SQL,
        ),
      }
      if (process.argv.includes('--print-fingerprints')) {
        console.log(JSON.stringify(fingerprints, null, 2))
        return
      }
      assert.equal(
        await health(client),
        true,
        'Fresh current migrations must pass order-editing release health',
      )
      assert.deepEqual(
        fingerprints.orderWorkbenchExactHistory,
        {
          artifact_count:
            OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_ARTIFACT_COUNT,
          artifact_hash: OPERATIONS_ORDER_WORKBENCH_EXACT_HISTORY_ARTIFACT_HASH,
        },
        'Fresh 0342 artifacts must match the reviewed exact fingerprint',
      )
      assert.equal(
        await exactHistoryHealth(client),
        true,
        'Fresh current migrations must pass exact-history health',
      )
      await verifyNegativeCases(client)
      await verifyExactHistoryNegativeCases(client)
    } finally {
      client.release()
      await pool.end()
    }
  } finally {
    spawnSync('docker', ['stop', '-t', '1', container], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    })
  }
  console.log(
    'Order editing release health disposable-PostgreSQL acceptance passed',
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
