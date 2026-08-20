/**
 * scripts/demo-reset.ts (`npm run demo:reset`)
 *
 * Rebuilds the isolated local demo D1 store from scratch:
 *   1. delete .wrangler-demo/
 *   2. apply migrations against that store
 *   3. seed products (scripts/seed-products.ts)
 *   4. configure product origins (scripts/configure-product-origins.ts)
 *
 * Everything here is scoped to .wrangler-demo via D1_PERSIST_TO. The default
 * `.wrangler/` store used by normal local dev is never touched: this script
 * never calls `wrangler` without an explicit --persist-to pointing at the
 * demo directory, and never sets D1_PERSIST_TO to anything else.
 */

import { existsSync, rmSync } from "fs";
import { join, resolve } from "path";
import { runWrangler, runNode, withLocalBin } from "./demo/proc-utils";

const DEMO_PERSIST_TO = join(process.cwd(), ".wrangler-demo");
const DEFAULT_PERSIST_TO = join(process.cwd(), ".wrangler");

/**
 * The delete / migrate / seed target below is the hardcoded DEMO_PERSIST_TO
 * constant, so there is no caller-supplied store path to validate. The one
 * thing that CAN vary is an inherited D1_PERSIST_TO: scripts/seed-products.ts
 * and scripts/configure-product-origins.ts read it, and this script overrides
 * it in the child env, so a value pointing anywhere else means the caller
 * expected a different store than the one being rebuilt here. Refuse rather
 * than silently rebuild the wrong one.
 */
function assertPersistToEnvIsDemoStore(): void {
  const envPersistTo = process.env.D1_PERSIST_TO;
  if (!envPersistTo) return;
  const resolvedEnv = resolve(envPersistTo);
  if (resolvedEnv === resolve(DEFAULT_PERSIST_TO)) {
    throw new Error(
      `D1_PERSIST_TO points at the default local dev store (${resolvedEnv}); the demo tooling must never touch it.`,
    );
  }
  if (resolvedEnv !== resolve(DEMO_PERSIST_TO)) {
    throw new Error(
      `D1_PERSIST_TO must be unset or point at ${resolve(DEMO_PERSIST_TO)}, got: ${resolvedEnv}`,
    );
  }
}

export function resetDemoStore(): void {
  assertPersistToEnvIsDemoStore();

  console.log(`\n[demo-reset] target store: ${DEMO_PERSIST_TO}`);

  if (existsSync(DEMO_PERSIST_TO)) {
    console.log("[demo-reset] deleting existing .wrangler-demo/ ...");
    // maxRetries/retryDelay ride out a brief EBUSY/ENOTEMPTY window on Windows
    // if a previous wrangler dev process's file handles haven't released yet.
    rmSync(DEMO_PERSIST_TO, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  const demoEnv: NodeJS.ProcessEnv = withLocalBin({ ...process.env, D1_PERSIST_TO: DEMO_PERSIST_TO });
  // These scripts must never see a CF API token: they are strictly local.
  delete demoEnv.CF_API_TOKEN;
  delete demoEnv.CLOUDFLARE_API_TOKEN;

  console.log("[demo-reset] applying migrations to the demo store...");
  runWrangler(
    ["d1", "migrations", "apply", "ventora-crm", "--local", "--persist-to", DEMO_PERSIST_TO],
    demoEnv,
  );

  console.log("[demo-reset] seeding demo products...");
  runNode(join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), ["scripts/seed-products.ts"], demoEnv);

  console.log("[demo-reset] configuring demo product origins...");
  runNode(
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    ["scripts/configure-product-origins.ts"],
    demoEnv,
  );

  console.log("[demo-reset] done.\n");
}

if (process.argv[1] && process.argv[1].endsWith("demo-reset.ts")) {
  resetDemoStore();
}
