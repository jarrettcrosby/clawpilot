import { defineConfig } from '@playwright/test'

const authPasswordConfigured = Boolean(process.env.UI_AUTH_PASSWORD)
const operatorSecretConfigured = Boolean(process.env.UI_OPERATOR_SECRET)

if (authPasswordConfigured !== operatorSecretConfigured) {
  throw new Error('UI_AUTH_PASSWORD and UI_OPERATOR_SECRET must be set together')
}

export default defineConfig({
  testDir: './tests',
  testMatch: ['ui-acceptance.spec.ts'],
  timeout: 300000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/ui-acceptance',
  use: {
    baseURL: process.env.UI_BASE_URL || 'http://localhost:4002',
    headless: true,
    actionTimeout: 10000,
    navigationTimeout: 30000,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
