import { test } from '@playwright/test';
import { verifyEarlierLogsDuringPolling, verifyScrollStability } from './viewer-scroll-fixture';

test.use({ browserName: 'firefox', viewport: { width: 1440, height: 760 } });
test('Firefox drawer follows new logs until manual scrolling and preserves reading position through background polls', async ({ page }) => {
  await verifyScrollStability(page, true);
});

test('Firefox Earlier logs stays enabled during a background poll and loads a queued click afterward', async ({ page }) => {
  await verifyEarlierLogsDuringPolling(page);
});
