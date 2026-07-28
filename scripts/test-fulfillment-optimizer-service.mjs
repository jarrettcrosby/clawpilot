import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const requirements = read('services/fulfillment-optimizer/requirements.txt')
for (const pinned of [
  'ortools==9.15.6755',
  'fastapi==0.140.7',
  'pydantic==2.13.4',
  'uvicorn==0.51.0',
]) {
  assert.ok(requirements.includes(pinned), `optimizer dependency is not pinned: ${pinned}`)
}

const dockerfile = read('services/fulfillment-optimizer/Dockerfile')
for (const fragment of [
  'python:3.13-slim@sha256:',
  'USER optimizer',
  '--no-access-log',
]) {
  assert.ok(dockerfile.includes(fragment), `optimizer image contract missing ${fragment}`)
}

const service = read('services/fulfillment-optimizer/optimizer_service/main.py')
for (const fragment of [
  'secrets.compare_digest',
  'OPTIMIZER_REQUEST_TOO_LARGE',
  'OPTIMIZER_INPUT_HASH_MISMATCH',
  'Depends(verify_bearer)',
  '"/v1/optimize"',
  '"/v1/assortments/optimize"',
  '"Cache-Control"',
]) {
  assert.ok(service.includes(fragment), `optimizer HTTP boundary missing ${fragment}`)
}
assert.ok(!service.includes('DATABASE_URL'), 'optimizer service must not receive database authority')

const solver = read('services/fulfillment-optimizer/optimizer_service/solver.py')
for (const fragment of [
  'num_search_workers = 1',
  'random_seed = 0',
  'MAX_UNITS = 80',
  'MAX_PAIRWISE_DISJUNCTIONS',
  'minimize_warehouses',
  'minimize_shipments_and_cartons',
  'minimize_estimated_total_cost_minor',
  'minimize_unused_volume_mm3',
  'stable_global_id_ties',
  'solve_assortment',
]) {
  assert.ok(solver.includes(fragment), `optimizer model missing ${fragment}`)
}

const adapter = read('app_src/lib/operations/orToolsFulfillmentOptimizer.ts')
for (const fragment of [
  'CLAWPILOT_FULFILLMENT_OPTIMIZER_ENABLED',
  'CLAWPILOT_FULFILLMENT_OPTIMIZER_URL',
  'CLAWPILOT_FULFILLMENT_OPTIMIZER_SECRET',
  'DeterministicFulfillmentOptimizer',
  'parseFulfillmentOptimizationResult',
  'ORTOOLS_TLS_REQUIRED',
  'AbortController',
  "redirect: 'error'",
  'one_unit_per_carton_safe_fallback',
]) {
  assert.ok(adapter.includes(fragment), `optimizer adapter missing ${fragment}`)
}
assert.ok(
  adapter.includes("!== '1') return null"),
  'hosted optimizer must remain disabled without explicit activation',
)

console.log('Fulfillment optimizer service contract tests passed.')
