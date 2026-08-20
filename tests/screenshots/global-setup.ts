/**
 * tests/screenshots/global-setup.ts
 *
 * Runs once before the screenshot capture projects. Two jobs:
 *   1. Fail fast with a clear message if the demo worker isn't up yet — this
 *      config has no `webServer`, so it's on scripts/demo-shots.ts to have
 *      started one first.
 *   2. Clear out any previous docs/screenshots/* output so a re-run never
 *      leaves stale images mixed in with the new set.
 */

import type { FullConfig } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";

const SCREENSHOTS_DIR = join(process.cwd(), "docs", "screenshots");

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? "http://127.0.0.1:8788";

  let healthy = false;
  try {
    const res = await fetch(`${baseURL}/healthz`);
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  if (!healthy) {
    throw new Error(
      `[global-setup] demo worker not reachable at ${baseURL}/healthz. ` +
        "This config has no webServer — run `npm run shots` (which starts and seeds " +
        "the demo worker first), not `playwright test --config playwright.screenshots.config.ts` directly.",
    );
  }

  const meRes = await fetch(`${baseURL}/api/admin/me`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  const me: unknown = meRes.ok ? await meRes.json() : null;
  if (JSON.stringify(me) !== JSON.stringify({ email: "dev@local" })) {
    throw new Error(
      `[global-setup] GET /api/admin/me did not return the expected DEV_AUTH_BYPASS identity ` +
        `at ${baseURL}. Refusing to run screenshot capture against what looks like a non-demo worker.`,
    );
  }

  if (existsSync(SCREENSHOTS_DIR)) {
    for (const entry of readdirSync(SCREENSHOTS_DIR)) {
      if (entry.endsWith(".png") || entry.endsWith(".jpg")) {
        rmSync(join(SCREENSHOTS_DIR, entry), { force: true });
      }
    }
  } else {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}
