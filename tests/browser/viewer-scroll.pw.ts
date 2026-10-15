import { test } from '@playwright/test';
import { verifyEarlierLogsDuringPolling, verifyScrollStability } from './viewer-scroll-fixture';

for (const variant of [{ name: 'standalone desktop', width: 1440, drawer: false }, { name: 'drawer desktop', width: 1440, drawer: true }, { name: 'drawer mobile', width: 390, drawer: true }]) test.describe(variant.name, () => {
  test.use({ viewport: { width: variant.width, height: 760 }, hasTouch: variant.width === 390 });
  test('follows new logs until manual scrolling and preserves reading position through background polls', async ({ page }) => {
    await verifyScrollStability(page, variant.drawer);
  });
});

test('Earlier logs stays enabled during a background poll and loads a queued click afterward', async ({ page }) => {
  await verifyEarlierLogsDuringPolling(page);
});
