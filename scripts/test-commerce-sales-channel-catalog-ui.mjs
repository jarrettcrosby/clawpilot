#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const panel = readFileSync(resolve(
  root,
  'app_src/components/settings/CommerceIntegrationPanel.tsx',
), 'utf8')

for (const contract of [
  'const COMMERCE_PROVIDER_OPTIONS',
  "provider: 'shopify'",
  "provider: 'faire'",
  'Add sales channel',
  'open={providerCatalogOpen}',
  'setSelectedSetupProvider(provider)',
  "selectedSetupProvider === 'shopify'",
  "selectedSetupProvider === 'faire'",
  'const configuredAccounts = integrations.accounts.filter(',
  '(account) => account.configured,',
  'const setupInProgressAccounts = integrations.accounts.filter(',
  '(account) => !account.configured,',
  '{configuredAccounts.map((account) => {',
  '{setupInProgressAccounts.map((account) => (',
  'No sales channels are connected yet.',
  'Setup in progress',
  'Resume setup',
]) {
  assert.ok(panel.includes(contract), `Missing sales-channel UI contract: ${contract}`)
}

assert.ok(
  !panel.includes('{integrations.accounts.map((account) => {'),
  'The connected-channel list must not render unconfigured account records',
)

const providers = ['shopify', 'faire']

function projectScenario(accounts, selectedSetupProvider = null) {
  const configuredAccounts = accounts.filter((account) => account.configured)
  const setupInProgressAccounts = accounts.filter((account) => !account.configured)
  return {
    connectedProviders: providers.filter((provider) => (
      configuredAccounts.some((account) => account.provider === provider)
    )),
    setupInProgressProviders: providers.filter((provider) => (
      setupInProgressAccounts.some((account) => account.provider === provider)
    )),
    visibleSetupProviders: selectedSetupProvider
      ? [selectedSetupProvider]
      : [],
  }
}

assert.deepEqual(
  projectScenario([]),
  {
    connectedProviders: [],
    setupInProgressProviders: [],
    visibleSetupProviders: [],
  },
  'Zero connections show neither provider setup form nor a connected identity',
)

assert.deepEqual(
  projectScenario([{ provider: 'shopify', configured: true }]),
  {
    connectedProviders: ['shopify'],
    setupInProgressProviders: [],
    visibleSetupProviders: [],
  },
  'A connected Shopify account does not expose unselected Faire setup',
)

assert.deepEqual(
  projectScenario([{ provider: 'faire', configured: false }]),
  {
    connectedProviders: [],
    setupInProgressProviders: ['faire'],
    visibleSetupProviders: [],
  },
  'An actual unconfigured account is presented only as setup in progress',
)

const catalogSelection = {
  providerCatalogOpen: false,
  ...projectScenario(
    [{ provider: 'shopify', configured: true }],
    'faire',
  ),
}
assert.deepEqual(
  catalogSelection,
  {
    providerCatalogOpen: false,
    connectedProviders: ['shopify'],
    setupInProgressProviders: [],
    visibleSetupProviders: ['faire'],
  },
  'Selecting Faire from the catalog closes it and renders only Faire setup',
)

console.log('Commerce sales-channel catalog UI contracts passed.')
