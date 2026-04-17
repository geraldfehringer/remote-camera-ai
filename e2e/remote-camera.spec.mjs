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

  // Alert Log assertions (Task 12 UI + Task 14).
  // The mint path emits two WS frames per alert: first without `llm` (summary
  // shows the 'LLM laeuft...' placeholder), then patched after the LLM call
  // returns with the real summary. The stub provider resolves synchronously;
  // real providers take 1-3 s. We wait for the placeholder to be REPLACED so
  // the test fails loudly if the LLM call silently errors (e.g. bad snapshot
  // path, missing API key → counters.llmFailed++ but UI stays on placeholder).
  const firstAlertItem = viewerPage.locator('[data-testid="alert-log-item"]').first()
  await expect(firstAlertItem).toBeVisible({ timeout: 15_000 })

  const firstAlertSummary = firstAlertItem.locator('.alert-log-summary')
  await expect(firstAlertSummary).toBeVisible({ timeout: 10_000 })
  await expect(firstAlertSummary).not.toHaveText(/^LLM laeuft\.\.\.$/, {
    timeout: 20_000
  })

  await cameraContext.close()
  await viewerContext.close()
  await homeContext.close()
})

test('homepage renders WhatsApp card and status API is open', async ({ browser, request }) => {
  const homeContext = await browser.newContext()
  const homePage = await homeContext.newPage()
  await homePage.goto('/')
  await expect(homePage.getByTestId('home-page')).toBeVisible()

  // Card is present — no token required.
  await expect(homePage.getByTestId('whatsapp-card')).toBeVisible()

  // Status endpoint is open (no auth gate).
  const statusWithoutToken = await request.get('/api/whatsapp/status')
  expect([200, 404]).toContain(statusWithoutToken.status())
  // 200 = enabled + sidecar reachable
  // 404 = whatsapp feature disabled via WHATSAPP_ENABLED=false (route not mounted)

  await homeContext.close()
})
