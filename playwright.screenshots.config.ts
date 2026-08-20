import { defineConfig, devices } from "@playwright/test";

// Screenshot-capture config for `npm run shots` (scripts/demo-shots.ts).
// Deliberately separate from playwright.config.ts (the backend e2e suite) —
// tests/unit/playwright-config.test.ts asserts literal substrings in that
// file, so it must not be touched here.
//
// No `webServer` key: scripts/demo-shots.ts starts the worker itself against
// the isolated .wrangler-demo D1 store before invoking this config, and
// tears it down afterward.

export default defineConfig({
  testDir: "tests/screenshots",
  globalSetup: "./tests/screenshots/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Every wait in tests/screenshots is a concrete locator against an
  // already-seeded local worker, so anything slower than this is a broken
  // selector rather than a slow page — fail fast instead of burning 30s on it.
  timeout: 15_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8788",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "desktop",
      testMatch: /capture\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
    },
    {
      name: "mobile",
      testMatch: /capture\.mobile\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
      },
    },
  ],
});
