import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    // Development-mode build (keeps import.meta.env.DEV test hooks) served by `vite preview`, not
    // `vite dev`: the dev client opens a WebSocket inside ORT's WASM thread workers, which trips a
    // Playwright Firefox assertion (FFPage._onWebSocketOpened). Separate outDir/port so neither
    // dist/ nor a running dev server is touched.
    command: 'npx vite build --mode development --outDir .e2e-dist && npx vite preview --outDir .e2e-dist --port 4173 --strictPort',
    env: { NODE_ENV: 'development' },
    timeout: 180_000,
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
  },
})
