import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', headless: true },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3000/login',
    reuseExistingServer: false,
    env: { PASS_KEY: 'e2e-access-key', OPENAI_API_KEY: '' },
  },
});
