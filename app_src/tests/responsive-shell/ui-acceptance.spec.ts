import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

test.use({ hasTouch: true })

async function expectWidth(locator: Locator, width: number) {
  await expect.poll(async () => Math.round((await locator.boundingBox())?.width ?? 0)).toBe(width)
}

async function expectContentBesideNavigation(page: Page, navigationWidth: number) {
  const navigation = page.getByTestId('desktop-navigation')
  const content = page.getByTestId('app-content')

  await expect.poll(async () => {
    const navigationBox = await navigation.boundingBox()
    const contentBox = await content.boundingBox()
    if (!navigationBox || !contentBox) return false
    return Math.round(contentBox.x) === Math.round(navigationBox.x + navigationWidth)
  }).toBe(true)
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))

  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth)
}

test('responsive shell: 1366x768 touch input keeps a real desktop drawer sibling', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/#dashboard')

  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)

  const desktopNavigation = page.getByTestId('desktop-navigation')
  const desktopPaper = page.getByTestId('desktop-navigation-paper')
  const desktopToggle = page.getByTestId('desktop-navigation-toggle')

  await expect(desktopNavigation).toBeVisible()
  await expect(page.getByTestId('mobile-navigation-toggle')).toBeHidden()
  await expect(page.getByTestId('mobile-bottom-navigation')).toBeHidden()
  await expectWidth(desktopNavigation, 220)
  await expectContentBesideNavigation(page, 220)
  expect(await desktopPaper.evaluate((element) => getComputedStyle(element).position)).toBe('relative')
  await expect(desktopToggle).toHaveAttribute('aria-expanded', 'true')

  await desktopToggle.click()

  await expectWidth(desktopNavigation, 76)
  await expectContentBesideNavigation(page, 76)
  await expect(desktopToggle).toHaveAttribute('aria-label', 'Expand sidebar')
  await expect(desktopNavigation.getByRole('button', { name: /sidebar/i })).toHaveCount(0)

  await page.reload()

  await expectWidth(desktopNavigation, 76)
  await expectContentBesideNavigation(page, 76)
  await expectNoHorizontalOverflow(page)
})

test('responsive shell: 900x599 is desktop regardless of height or touch input', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 599 })
  await page.goto('/#dashboard')

  const desktopNavigation = page.getByTestId('desktop-navigation')

  expect(await page.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0)
  await expect(desktopNavigation).toBeVisible()
  await expectWidth(desktopNavigation, 220)
  await expectContentBesideNavigation(page, 220)
  await expect(page.getByTestId('desktop-navigation-toggle')).toBeVisible()
  await expect(page.getByTestId('mobile-navigation-toggle')).toBeHidden()
  await expect(page.getByTestId('mobile-bottom-navigation')).toBeHidden()
  await expectNoHorizontalOverflow(page)
})

test('responsive shell: 390x844 exposes compact navigation and dismissible drawers', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#dashboard')

  const desktopNavigation = page.getByTestId('desktop-navigation')
  const mobileToggle = page.getByTestId('mobile-navigation-toggle')
  const mobileDrawer = page.getByTestId('mobile-navigation-drawer')
  const bottomNavigation = page.getByTestId('mobile-bottom-navigation')
  const moreAction = page.getByTestId('nav-bottom-more')

  await expect(desktopNavigation).toBeHidden()
  await expect(page.getByTestId('desktop-navigation-toggle')).toBeHidden()
  await expect(mobileToggle).toBeVisible()
  await expect(mobileToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(bottomNavigation).toBeVisible()
  await expect(bottomNavigation.getByRole('button')).toHaveCount(5)
  await expect(page.getByTestId('nav-bottom-dashboard')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-projects')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-pipeline')).toBeVisible()
  await expect(page.getByTestId('nav-bottom-agents')).toBeVisible()
  await expect(page.getByTestId('runtime-chip')).toHaveCount(1)
  await expect(page.getByTestId('runtime-chip')).toBeHidden()

  await moreAction.click()
  await expect(mobileDrawer).toBeVisible()
  await expect(moreAction).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(mobileDrawer).toBeHidden()
  await expect(moreAction).toHaveAttribute('aria-expanded', 'false')

  await mobileToggle.click()
  await expect(mobileDrawer).toBeVisible()
  const backdrop = page.getByTestId('mobile-navigation').locator('.MuiBackdrop-root')
  const backdropBox = await backdrop.boundingBox()
  expect(backdropBox).not.toBeNull()
  await page.mouse.click((backdropBox?.x ?? 0) + (backdropBox?.width ?? 390) - 8, 400)
  await expect(mobileDrawer).toBeHidden()

  await mobileToggle.click()
  await page.getByTestId('nav-mobile-versions').click()
  await expect(page).toHaveURL(/#versions$/)
  await expect(mobileDrawer).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Versions', exact: true, level: 5 })).toBeVisible()

  await mobileToggle.click()
  await page.getByTestId('nav-mobile-docs').click()
  await expect(page).toHaveURL(/#docs$/)
  await expect(mobileDrawer).toBeHidden()

  const appHeader = page.getByTestId('app-header')
  const docsToolbar = page.getByTestId('docs-mobile-toolbar')
  const docsToggle = page.getByTestId('docs-navigation-toggle')
  const headerBox = await appHeader.boundingBox()
  const docsToolbarBox = await docsToolbar.boundingBox()

  await expect(docsToggle).toBeVisible()
  await expect(docsToggle).toHaveAttribute('aria-expanded', 'false')
  expect(await docsToggle.evaluate((element) => getComputedStyle(element).position)).not.toBe('fixed')
  expect(headerBox).not.toBeNull()
  expect(docsToolbarBox).not.toBeNull()
  expect(Math.round(docsToolbarBox?.y ?? 0)).toBeGreaterThanOrEqual(
    Math.round((headerBox?.y ?? 0) + (headerBox?.height ?? 0)),
  )
  await expectNoHorizontalOverflow(page)
})
