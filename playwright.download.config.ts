import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/download', outputDir: './test-results/download', testMatch: '**/*.pw.ts',
  fullyParallel: false, workers: 1, forbidOnly: Boolean(process.env.CI), retries: 0, reporter: 'list',
  use: { serviceWorkers: 'allow', acceptDownloads: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
