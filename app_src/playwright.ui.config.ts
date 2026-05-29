import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: ['ui-acceptance.spec.ts'],
  timeout: 300000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.UI_BASE_URL || 'http://127.0.0.1:4002',
    headless: true,
  },
})
