/**
 * scripts/demo/proc-utils.ts
 *
 * Small process/network helpers shared by the demo scripts. Everything here
 * calls `wrangler`/`node` directly through their resolved entry-point paths
 * (mirroring scripts/verify-migration-state.ts) instead of shelling out to a
 * bare `wrangler`/`npx` command. That keeps behavior identical on Windows
 * PowerShell/Git Bash and CI POSIX shells alike, with no PATH surprises.
 */

import { execFileSync, spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join, delimiter } from "path";

/**
 * Prepends node_modules/.bin to PATH so any subprocess spawned with this env
 * resolves `wrangler`/`tsx`/etc. to THIS repo's pinned devDependency version
 * instead of whatever (if anything) is globally installed on the host.
 * scripts/seed-products.ts and scripts/configure-product-origins.ts shell out
 * to a bare `wrangler` command internally, so this matters even when we invoke
 * them directly through node rather than through `npm run`.
 */
export function withLocalBin(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const localBin = join(process.cwd(), "node_modules", ".bin");
  const next: NodeJS.ProcessEnv = { ...env };
  // Windows spells this variable `Path` (and treats it case-insensitively);
  // POSIX spells it `PATH`. Blindly writing a `PATH` key on Windows leaves the
  // object holding BOTH keys, and which one the child process actually sees is
  // libuv's choice. That is exactly how a subprocess ends up resolving a global
  // `wrangler` (or none at all) instead of this repo's pinned devDependency.
  // So: find whatever casing is already there and overwrite that key.
  const pathKeys = Object.keys(next).filter((key) => key.toUpperCase() === "PATH");
  if (pathKeys.length === 0) pathKeys.push("PATH");
  for (const key of pathKeys) {
    const existing = next[key];
    next[key] = existing ? `${localBin}${delimiter}${existing}` : localBin;
  }
  return next;
}

export const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
export const PLAYWRIGHT_TEST_BIN = join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");

export function assertBinsExist(): void {
  for (const bin of [WRANGLER_BIN, PLAYWRIGHT_TEST_BIN]) {
    if (!existsSync(bin)) {
      throw new Error(`expected bin not found: ${bin} (run npm install first)`);
    }
  }
}

/** Runs `wrangler <args>` to completion, streaming output, and throws on non-zero exit. */
export function runWrangler(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });
}

/** Runs an arbitrary node-executed script to completion, streaming output. */
export function runNode(scriptPath: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });
}

/** Spawns `wrangler <args>` as a long-running background process (e.g. `dev`). */
export function spawnWrangler(args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcess {
  return spawn(process.execPath, [WRANGLER_BIN, ...args], {
    stdio: "inherit",
    env,
    cwd: process.cwd(),
  });
}

/** Polls `url` until it returns any HTTP response (not necessarily 2xx) or times out. */
export async function waitForHttpUp(url: string, timeoutMs = 60_000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      // Any response (even a 404) proves the TCP/HTTP server is accepting connections.
      void res.body?.cancel();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(intervalMs);
    }
  }
  throw new Error(`timed out waiting for ${url} to come up: ${String(lastErr)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gracefully stops a spawned child process, escalating to SIGKILL if it lingers. */
export async function stopProcess(child: ChildProcess | null, graceMs = 5000): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    // Windows has no SIGTERM semantics for arbitrary processes reliably killing
    // child trees spawned by wrangler (esbuild/miniflare subprocesses); on
    // win32 go straight to a forceful kill via taskkill against the tree.
    if (process.platform === "win32" && child.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Process may have already exited.
      }
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, graceMs);
  });
}

/**
 * Kills whatever is listening on `port`, by PID, on Windows.
 *
 * `wrangler dev`'s `bin/wrangler.js` entry point re-spawns the real work into
 * a `wrangler-dist/cli.js` child and then exits itself, so by the time
 * stopProcess()'s taskkill runs against the PID we spawned, that PID may
 * already be gone and the real (listening) process has been re-parented and
 * survives the tree-kill. Falling back to "whatever owns this port" is the
 * only reliable way to guarantee the demo server (and its file locks on
 * .wrangler-demo) is actually gone before the next `npm run shots` run tries
 * to delete that directory.
 */
export async function killWhateverOwnsPort(port: string | number): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | ` +
          "Select-Object -ExpandProperty OwningProcess -Unique | " +
          "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
      ],
      { stdio: "ignore" },
    );
  } catch {
    // No listener on that port (or powershell/Get-NetTCPConnection unavailable), so nothing to clean up.
  }
}

/**
 * SHA-256 hex digest. Must match src/connectors/base.ts's sha256Hex exactly
 * (Node's webcrypto `crypto.subtle` matches the Workers runtime implementation)
 * so scripts/seed-demo.ts can compute the same `external_id` the real manual/csv
 * connectors would produce, letting Phase B freeze `imported_at` by matching on
 * the natural (product_id, source, external_id) key instead of guessing ids.
 */
export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function sqlString(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlNumber(value: number | null): string {
  return value === null ? "NULL" : String(value);
}

/**
 * `wrangler dev` args shared by scripts/seed-demo.ts (ephemeral seeding server)
 * and scripts/demo-shots.ts (long-lived screenshot server). Mirrors the flag set
 * in playwright.config.ts's e2e webServer command, plus `--local-upstream`.
 *
 * `--local-upstream localhost` is load-bearing. wrangler.jsonc declares
 * production `custom_domain` routes, and `wrangler dev` simulates them: without
 * this flag the Worker sees `https://crm.<production-domain>/…` with a matching
 * `Host` header, so isLocalDevRequest() in src/lib/auth.ts rejects the request
 * and every admin call 500s with "DEV_AUTH_BYPASS is only allowed on local
 * development hosts", even though we're listening on 127.0.0.1. Forcing the
 * simulated origin back to `localhost` makes the hostname check pass.
 *
 * DEV_AUTH_BYPASS_ALLOW_NONLOCAL_HOST is kept as a belt-and-braces second
 * escape hatch, and the CF_ACCESS_* vars are set for parity even though the
 * bypass path never reaches them.
 */
export function demoWranglerDevArgs(port: string, persistTo: string): string[] {
  return [
    "dev",
    "--port",
    port,
    "--persist-to",
    persistTo,
    "--local-upstream",
    "localhost",
    "--test-scheduled",
    "--var",
    "DEV_AUTH_BYPASS:true",
    "--var",
    "DEV_AUTH_BYPASS_ALLOW_NONLOCAL_HOST:true",
    "--var",
    "CF_ACCESS_TEAM_DOMAIN:demo-access.test",
    "--var",
    "CF_ACCESS_AUD:demo-aud",
    "--var",
    "CF_ACCESS_JWKS_URL:http://127.0.0.1:18989/certs",
  ];
}
