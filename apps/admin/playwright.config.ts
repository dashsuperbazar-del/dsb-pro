import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Deliberately zero, including on CI. These specs cover the money path; a
  // retry would convert an intermittent financial-path defect into a green
  // run and hide it. Diagnose failures from the trace instead of re-running.
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    // Without these a CI-only intermittent failure leaves nothing to diagnose,
    // which is exactly how the pos.spec.ts money-path failure went unexplained
    // across several runs.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
