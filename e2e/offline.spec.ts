import { expect, test } from '@playwright/test';

// Runs in its own browser instance (distinct launch options): reusing a browser whose earlier contexts
// registered service workers made Chromium fail to create this test's context intermittently.
test.use({
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--zino-offline-test',
    ],
  },
});

test('app shell works offline after the first visit', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zino3D' })).toBeVisible();
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  await page.reload(); // let the active worker control the page
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Zino3D' })).toBeVisible();
  await page
    .getByRole('button', { name: /Sample project/ })
    .first()
    .click();
  await expect(page.locator('.viewport-canvas')).toBeVisible();
  await expect(page.getByRole('tree').getByText('Car', { exact: true })).toBeVisible();
  await context.setOffline(false);
});
