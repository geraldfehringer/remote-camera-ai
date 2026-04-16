import { expect, test } from '@playwright/test'

test('camera and viewer connect through the browser flow', async ({ browser }) => {
  const origin = 'https://127.0.0.1'

  const homeContext = await browser.newContext()
  const homePage = await homeContext.newPage()
  await homePage.goto('/')
  await expect(homePage.getByTestId('home-page')).toBeVisible()
  await homePage.getByTestId('create-session').click()

  const cameraHref = await homePage.getByTestId('camera-link').getAttribute('href')
  const viewerHref = await homePage.getByTestId('viewer-link').getAttribute('href')

  expect(cameraHref).toBeTruthy()
  expect(viewerHref).toBeTruthy()

  const cameraContext = await browser.newContext({
    permissions: ['camera'],
  })
  await cameraContext.grantPermissions(['camera'], { origin })
  const cameraPage = await cameraContext.newPage()

  const viewerContext = await browser.newContext()
  const viewerPage = await viewerContext.newPage()

  await viewerPage.goto(viewerHref)
  await expect(viewerPage.getByTestId('viewer-video')).toBeVisible()
  await expect(viewerPage.getByText('Warte auf Kamera-Sender')).toBeVisible()

  await cameraPage.goto(cameraHref)
  await expect(cameraPage.getByTestId('camera-video')).toBeVisible()
  await cameraPage.getByTestId('target-label').fill('motion-only')
  await cameraPage.getByTestId('sample-rate').selectOption('800')
  await cameraPage.getByTestId('start-camera').click()

  await expect(cameraPage.getByText('Stream aktiv')).toBeVisible()
  await expect(viewerPage.getByText('Kamera verbunden')).toBeVisible()

  await viewerPage.waitForFunction(() => {
    const video = document.querySelector('[data-testid="viewer-video"]')
    return Boolean(video && video.readyState >= 2)
  })

  await cameraPage.waitForFunction(() => {
    const video = document.querySelector('[data-testid="camera-video"]')
    return Boolean(video && video.readyState >= 2)
  })

  await expect(viewerPage.getByTestId('alert-card')).toBeVisible({ timeout: 30_000 })

  const snapshot = viewerPage.getByTestId('snapshot-image')
  await expect(snapshot).toBeVisible({ timeout: 30_000 })

  const snapshotSrc = await snapshot.getAttribute('src')
  expect(snapshotSrc).toContain('/api/sessions/')

  await cameraContext.close()
  await viewerContext.close()
  await homeContext.close()
})
