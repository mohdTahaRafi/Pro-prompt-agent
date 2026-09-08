import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,     // a persistent context with an extension is a single
                            // browser profile; parallel workers collide on it
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: {
    command: 'npx http-server tests/e2e/fixtures -p 5599 --silent',
    port: 5599, reuseExistingServer: true,
  },
});
