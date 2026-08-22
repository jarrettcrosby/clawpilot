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
  OPERATIONS_COMMERCE_ORDER_WORKBENCH_FINGERPRINT_SQL,
  OPERATIONS_ORDER_EDITING_RELEASE_HEALTH_SQL,
  OPERATIONS_ORDER_SHIPMENT_ADDRESS_FINGERPRINT_SQL,
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

  for (const statement of [
    `ALTER TABLE public.operations_commerce_order_workbench
       DISABLE TRIGGER validate_operations_commerce_order_workbench`,
    `ALTER TABLE public.operations_commerce_provider_write_controls
       DISABLE TRIGGER operations_commerce_provider_write_controls_validate`,
    `ALTER TABLE public.operations_order_shipment_address_working_copies
       DISABLE TRIGGER validate_operations_order_shipment_address_working_copy`,
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
      for (const file of files.slice(workbenchIndex)) {
        await applyMigration(client, file)
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
      await verifyNegativeCases(client)
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
