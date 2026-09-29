// Speed/memory benchmark (not part of the gate): npx playwright test -c playwright.bench.config.ts
// Inputs via env: BENCH_NATIVE (large native PDF), BENCH_SCAN (large scanned PDF).
import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  testDir: './tests/bench',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
