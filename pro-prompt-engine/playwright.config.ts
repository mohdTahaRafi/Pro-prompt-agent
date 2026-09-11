import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Playwright's default testMatch is *.spec.ts only. §15's two benchmarks
  // (gate-wake.bench.ts, copilot.bench.ts) use the doc's own `.bench.ts`
  // naming (§15's table names `copilot.bench.ts` directly) but still need
  // to run as real, CI-gated, pass/fail Playwright tests — every other
  // §15 hard-gate metric already does.
  testMatch: /.*\.(spec|bench)\.ts/,
  timeout: 30_000,
  fullyParallel: false,     // a persistent context with an extension is a single
                            // browser profile; parallel workers collide on it
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: [
    {
      command: 'npx http-server tests/e2e/fixtures -p 5599 --silent',
      port: 5599, reuseExistingServer: true,
    },
    // [Phase 3] a SECOND static server, on a port deliberately absent from
    // wxt.config.ts's e2e host_permissions — the one origin in this whole
    // suite that is genuinely, never granted, mandatory or otherwise. Needed
    // because localhost:5599 is a mandatory host permission for the e2e
    // build (§8.2's own sidestep), so chrome.permissions.contains() is
    // always true for it and it cannot stand in for an ungranted origin.
    {
      command: 'npx http-server tests/e2e/fixtures -p 5601 --silent',
      port: 5601, reuseExistingServer: true,
    },
  ],
});
