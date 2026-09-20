import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/distribution',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
    reducedMotion: 'reduce', serviceWorkers: 'block', trace: 'retain-on-failure',
  },
});
