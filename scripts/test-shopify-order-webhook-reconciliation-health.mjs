#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationPath = resolve(
  root,
  'db/migrations/0303_operations_shopify_order_webhook_reconciliation.sql',
)
const healthPath = resolve(
  root,
  'app_src/lib/persistence/shopifyOrderWebhookReconciliationHealth.ts',
)
const routePath = resolve(root, 'app_src/app/api/health/route.ts')
const packagePath = resolve(root, 'package.json')
const ciPath = resolve(root, '.github/workflows/ci.yml')
const predeployPath = resolve(root, 'scripts/verify-predeploy.mjs')

const migration = readFileSync(migrationPath, 'utf8')
const health = readFileSync(healthPath, 'utf8')
const route = readFileSync(routePath, 'utf8')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
const ci = readFileSync(ciPath, 'utf8')
const predeploy = readFileSync(predeployPath, 'utf8')
const checksum = createHash('sha256').update(migration).digest('hex')

assert.match(
  health,
  new RegExp(checksum, 'u'),
  'health must pin the exact 0303 migration checksum',
)
for (const required of [
  'operations_shopify_order_webhook_commands',
  'operations_shopify_order_webhook_attempts',
  'operations_shopify_order_webhook_outcomes',
  'protect_shopify_order_webhook_command_write',
  'protect_shopify_order_webhook_attempt_write',
  'protect_shopify_order_webhook_outcome_write',
  'protect_shopify_order_webhook_account_drift',
  'protect_shopify_order_webhook_credential_drift',
  'protect_shopify_order_webhook_membership_drift',
]) assert.match(health, new RegExp(required, 'u'))
for (const exactCatalogEvidence of [
  'public.schema_migrations',
  'public.operations_shopify_order_webhook_plan_is_valid(jsonb)',
  'information_schema.columns',
  'pg_get_function_result',
  'pg_get_constraintdef',
  'pg_get_indexdef',
  'installed_index.indpred',
  'installed_trigger.tgqual',
  'installed_trigger.tgfoid =',
  'pg_get_triggerdef',
  'complete_trigger.tgname',
  'complete_trigger.tgisinternal',
  'complete_trigger.tgfoid::regprocedure',
]) assert.match(health, new RegExp(
  exactCatalogEvidence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
  'u',
))
assert.match(migration, /ops_shopify_order_webhook_one_open_idx/u)
assert.doesNotMatch(health, /to_regclass\(required_table\.name\)/u)

assert.match(route, /SHOPIFY_ORDER_WEBHOOK_RECONCILIATION_HEALTH_SQL/u)
assert.match(
  route,
  /operations_shopify_order_webhook_reconciliation_applied/u,
)
assert.match(route, /shopifyOrderWebhookReconciliation/u)

const expected = [
  'node scripts/test-shopify-order-webhook-reconciliation.mjs',
  'node scripts/test-shopify-order-webhook-reconciliation-postgres.mjs',
  'node scripts/test-shopify-order-webhook-reconciliation-health.mjs',
]
const testCommand = String(
  packageJson.scripts['test:shopify-order-webhook-reconciliation'] || '',
)
for (const command of expected) assert.ok(testCommand.includes(command))
assert.ok(
  String(packageJson.scripts['test:commerce'] || '')
    .includes('npm run test:shopify-order-webhook-reconciliation'),
)
assert.match(ci, /run: npm run test:shopify-order-webhook-reconciliation/u)
for (const path of [
  '0303_operations_shopify_order_webhook_reconciliation.sql',
  'test-shopify-order-webhook-reconciliation-postgres.mjs',
  'test-shopify-order-webhook-reconciliation-health.mjs',
]) assert.match(predeploy, new RegExp(path, 'u'))

console.log('Shopify order webhook reconciliation health and release gates passed')
