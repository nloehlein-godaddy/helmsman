import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'browser.pw.ts', outputDir: '../../../test-results/run-presentation', workers: 1,
  reporter: 'list', retries: 0, use: { trace: 'retain-on-failure', locale: 'en-US', timezoneId: 'UTC' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
});
