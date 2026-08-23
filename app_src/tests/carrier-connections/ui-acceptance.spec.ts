import { expect, test } from '@playwright/test'

type DirectConnection = {
  globalId: string
  provider: 'ups_rest'
  environment: 'sandbox'
  displayName: string
  status: 'active' | 'disabled'
  configured: boolean
  verificationStatus: 'verified'
  allowedCapabilities: string[]
  carrierAccounts: Array<{
    globalId: string
    displayName: string
    senderName: string
    accountNumberLastFour: string
    status: 'active'
  }>
  managedBy: null
}

test('local carrier fixture covers setup, account control, diagnostics, and printing handoff', async ({ page }) => {
  const directConnection: DirectConnection = {
    globalId: 'gica9005001',
    provider: 'ups_rest',
    environment: 'sandbox',
    displayName: 'AG Alchemy UPS Sandbox',
    status: 'active',
    configured: true,
    verificationStatus: 'verified',
    allowedCapabilities: ['sandbox_rate', 'sandbox_label'],
    carrierAccounts: [{
      globalId: 'gcca9005001',
      displayName: 'AG Alchemy UPS billing',
      senderName: 'AG Alchemy',
      accountNumberLastFour: '4242',
      status: 'active',
    }],
    managedBy: null,
  }
  const directActions: Array<Record<string, unknown>> = []

  await page.route('**/api/integrations/carriers', async (route) => {
    if (route.request().method() === 'PATCH') {
      const action = route.request().postDataJSON() as Record<string, unknown>
      directActions.push(action)
      if (action.action === 'set-enabled') {
        directConnection.status = action.enabled === true ? 'active' : 'disabled'
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, integrations: { accounts: [directConnection] } }),
    })
  })
  await page.route('**/api/integrations/brokered-transport', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, canActivate: true, integrations: { accounts: [] } }),
    })
  })

  await page.goto('/dev/carrier-connections')
  await expect(page.getByTestId('carrier-connections-list')).toBeVisible()
  await expect(page.getByText('AG Alchemy UPS billing ending 4242')).toBeVisible()

  const troubleshoot = page.getByTestId('carrier-connections-troubleshoot')
  await expect(troubleshoot.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Carrier integrations', { exact: true })).toHaveCount(0)

  const upsConnection = page.getByTestId('carrier-connection-ups_rest-sandbox')
  const upsSwitch = upsConnection.getByRole('switch')
  await expect(upsSwitch).toBeChecked()
  await upsSwitch.click()
  await expect(upsSwitch).not.toBeChecked()
  await expect(upsConnection.getByText('Off', { exact: true })).toBeVisible()
  await expect(page.getByText('UPS disabled.')).toBeVisible()
  await upsSwitch.click()
  await expect(upsSwitch).toBeChecked()
  await expect(upsConnection.getByText('On', { exact: true })).toBeVisible()
  await expect(page.getByText('UPS enabled.')).toBeVisible()
  expect(directActions).toEqual([
    { action: 'set-enabled', provider: 'ups_rest', environment: 'sandbox', enabled: false },
    { action: 'set-enabled', provider: 'ups_rest', environment: 'sandbox', enabled: true },
  ])

  await page.getByRole('button', { name: 'Add carrier', exact: true }).click()
  const providerPicker = page.getByTestId('carrier-provider-picker')
  await expect(providerPicker.getByText('UPS', { exact: true })).toBeVisible()
  await expect(providerPicker.getByText('FedEx', { exact: true })).toBeVisible()
  await expect(providerPicker.getByText('Worldwide Express', { exact: true })).toBeVisible()
  await expect(providerPicker.getByText('USPS', { exact: true })).toBeVisible()
  await expect(page.getByTestId('carrier-provider-usps_rest')).toBeDisabled()
  const uspsUnavailable = page.getByTestId('carrier-provider-usps_rest')
    .getByText('Unavailable', { exact: true })
  await expect(uspsUnavailable).toHaveCount(2)
  await expect(uspsUnavailable.first()).toBeVisible()

  await page.getByRole('textbox', { name: 'Search carriers' }).fill('Worldwide')
  await expect(providerPicker.getByText('Worldwide Express', { exact: true })).toBeVisible()
  await expect(providerPicker.getByText('FedEx', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Set up label printing' }).click()
  await expect(page).toHaveURL(/#operations\/printing$/)
  await expect(page.getByTestId('carrier-connections-printing-handoff'))
    .toHaveText('Local fixture handoff: #operations/printing')
})
