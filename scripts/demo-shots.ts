/**
 * scripts/demo-shots.ts (`npm run shots`)
 *
 * One-command orchestrator for the documentation screenshot set:
 *   1. reset the isolated demo D1 store (scripts/demo-reset.ts)
 *   2. seed the fictional dataset (scripts/seed-demo.ts, its own ephemeral server)
 *   3. start the long-lived demo worker on :8788 against .wrangler-demo
 *   4. run the Playwright screenshot config against it
 *   5. tear the worker down (always, even on failure)
 *
 * Never touches the default `.wrangler/` store: every wrangler invocation
 * below is scoped to .wrangler-demo via --persist-to.
 */

import { join } from "path";
import { execFileSync } from "child_process";
import { resetDemoStore } from "./demo-reset";
import {
  spawnWrangler,
  waitForHttpUp,
  stopProcess,
  withLocalBin,
  demoWranglerDevArgs,
  PLAYWRIGHT_TEST_BIN,
  assertBinsExist,
  killWhateverOwnsPort,
} from "./demo/proc-utils";

const DEMO_PERSIST_TO = join(process.cwd(), ".wrangler-demo");
const PORT = "8788";
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TSX_CLI = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

async function main(): Promise<void> {
  assertBinsExist();

  console.log("\n=== [1/4] Resetting demo D1 store ===");
  resetDemoStore();

  console.log("\n=== [2/4] Seeding fictional demo dataset ===");
  const seedEnv = withLocalBin({
    ...process.env,
    VENTORA_DEMO_SEED: "yes-fake-local-data",
    D1_PERSIST_TO: DEMO_PERSIST_TO,
    DEMO_BASE_URL: BASE_URL,
  });
  delete seedEnv.CF_API_TOKEN;
  delete seedEnv.CLOUDFLARE_API_TOKEN;
  execFileSync(process.execPath, [TSX_CLI, "scripts/seed-demo.ts"], {
    stdio: "inherit",
    env: seedEnv,
    cwd: process.cwd(),
  });

  console.log("\n=== [3/4] Starting demo worker on :8788 ===");
  const serverEnv = withLocalBin({ ...process.env });
  delete serverEnv.CF_API_TOKEN;
  delete serverEnv.CLOUDFLARE_API_TOKEN;
  const server = spawnWrangler(demoWranglerDevArgs(PORT, DEMO_PERSIST_TO), serverEnv);
  let exitCode = 0;

  try {
    await waitForHttpUp(`${BASE_URL}/healthz`, 90_000);

    console.log("\n=== [4/4] Capturing screenshots with Playwright ===");
    execFileSync(
      process.execPath,
      [PLAYWRIGHT_TEST_BIN, "test", "--config", "playwright.screenshots.config.ts"],
      { stdio: "inherit", env: process.env, cwd: process.cwd() },
    );
  } catch (err) {
    exitCode = 1;
    console.error("[demo-shots] failed:", err instanceof Error ? err.message : err);
  } finally {
    console.log("\n[demo-shots] stopping demo worker...");
    await stopProcess(server);
    await killWhateverOwnsPort(PORT);
  }

  if (exitCode !== 0) process.exit(exitCode);
  console.log("\n[demo-shots] done. Screenshots written to docs/screenshots/.\n");
}

main().catch((err) => {
  console.error("[demo-shots] fatal:", err);
  process.exit(1);
});
