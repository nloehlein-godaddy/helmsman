import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'browser.pw.ts', outputDir: '../../../test-results/underway', workers: 1,
  reporter: 'list', retries: 0, use: { trace: 'retain-on-failure', locale: 'en-US', timezoneId: 'UTC' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
});
