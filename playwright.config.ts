import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep Wrangler's test configuration writable and separate from user settings.
const localConfig = resolve('.sites-runtime/playwright-config');
mkdirSync(localConfig, { recursive: true });

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 960 } } },
    { name: 'mobile', use: { viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'pnpm start --port 4173',
    env: { XDG_CONFIG_HOME: localConfig },
    url: 'http://127.0.0.1:4173/paths',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
