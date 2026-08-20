import { defineConfig, devices } from "@playwright/test";

function parseE2EPort(value: string | undefined): string {
  if (value === undefined || value === "") return "8787";
  if (!/^\d+$/.test(value)) throw new Error("E2E_PORT must be a numeric TCP port");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("E2E_PORT must be a numeric TCP port");
  }
  return String(port);
}

const e2ePort = parseE2EPort(process.env.E2E_PORT);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: `npm run build:admin && npm run db:migrate && npm run db:seed && npm run db:origins && wrangler dev --port ${e2ePort} --test-scheduled --var DEV_AUTH_BYPASS:true --var DEV_AUTH_BYPASS_ALLOW_NONLOCAL_HOST:true --var CF_ACCESS_TEAM_DOMAIN:e2e-access.test --var CF_ACCESS_AUD:e2e-aud --var CF_ACCESS_JWKS_URL:http://127.0.0.1:18989/certs`,
    url: `${e2eBaseUrl}/healthz`,
    reuseExistingServer: false,
    timeout: 900_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
