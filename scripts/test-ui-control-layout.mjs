#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

const theme = read('app_src/lib/theme.ts')
for (const fragment of [
  'MuiDialogActions',
  "flexWrap: 'wrap'",
  'gap: 8',
  'marginLeft: 0',
]) {
  assert.ok(
    theme.includes(fragment),
    `Missing shared dialog action layout guard: ${fragment}`,
  )
}

const journey = read(
  'app_src/components/settings/IntegrationSetupJourney.tsx',
)
for (const fragment of [
  "'& .MuiButton-root'",
  'flexShrink: 0',
  "whiteSpace: 'nowrap'",
  "'& > .MuiStack-root'",
  "flexWrap: 'wrap'",
]) {
  assert.ok(
    journey.includes(fragment),
    `Missing setup-journey action layout guard: ${fragment}`,
  )
}

const commerce = read(
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
)
assert.ok(
  commerce.includes("gridTemplateColumns: 'minmax(0, 1fr)'"),
  'Sales-channel setup cards must size against the Settings container',
)
assert.ok(
  !commerce.includes(
    "gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }",
  ),
  'Sales-channel cards must not switch columns from the outer viewport width',
)
assert.ok(
  (commerce.match(/flexWrap="wrap"/g) || []).length >= 2,
  'Shopify and Faire provider action rows must wrap instead of shrinking buttons',
)

console.log('Shared UI control layout contracts passed.')
