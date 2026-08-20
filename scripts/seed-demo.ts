/**
 * scripts/seed-demo.ts (`npm run demo:seed`)
 *
 * Seeds the fictional local demo dataset (scripts/demo/dataset.ts) into the
 * isolated .wrangler-demo D1 store, via a hybrid transport:
 *
 *   Phase A (HTTP, against the real admin API): customers, testimonials,
 *     feedback items, manual + CSV review imports, connector configs. Real
 *     API calls mean assertFirewallSafe and product-link bookkeeping run for
 *     real, which is what proves this dataset is firewall-safe.
 *
 *   Phase B (direct SQL via `wrangler d1 execute --local --persist-to
 *     .wrangler-demo`): the handful of things the API can't do. Freezing
 *     created_at/updated_at, freezing imported_at on EVERY review row (both
 *     the rows Phase A imported over HTTP and the rows inserted here),
 *     freezing widget_public_key, setting feedback upvotes and connector
 *     last_status/last_polled_at/last_inserted, and inserting rss/g2/
 *     trustpilot review rows (their API import paths hit the live network,
 *     which this offline fixture must never do).
 *
 * Every review row therefore lands with a deterministic imported_at, so
 * re-running `npm run shots` does not churn the committed screenshots.
 *
 * This script always starts and owns its own `wrangler dev` server (see
 * main() below) so it can never write into a server someone else started,
 * and it has no --remote code path anywhere: not gated behind a flag, just
 * absent.
 */

import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
  runWrangler,
  spawnWrangler,
  waitForHttpUp,
  stopProcess,
  sqlString,
  sqlNumber,
  sha256Hex,
  withLocalBin,
  demoWranglerDevArgs,
  killWhateverOwnsPort,
} from "./demo/proc-utils";
import {
  CUSTOMERS,
  TESTIMONIALS,
  FEEDBACK_ITEMS,
  MANUAL_REVIEWS,
  CSV_REVIEW_BATCHES,
  SQL_REVIEWS,
  CONNECTOR_CONFIGS,
  frozenIso,
  PRODUCT_SLUGS,
} from "./demo/dataset";

const DEMO_PERSIST_TO = join(process.cwd(), ".wrangler-demo");
const DEFAULT_PERSIST_TO = join(process.cwd(), ".wrangler");
const BASE_URL = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:8788";
const CSRF_HEADERS = { "X-Ventora-CSRF": "1", "Content-Type": "application/json" };

// Fixed 32-hex-char widget keys. Must stay valid against /^wk_[0-9a-f]{32}$/
// (scripts/verify-migration-state.ts and tests/e2e/canonical-flow.spec.ts assert this shape).
const WIDGET_KEY_SUFFIX: Record<string, string> = {
  [PRODUCT_SLUGS.camaudit]: "ca11",
  [PRODUCT_SLUGS.grantpipe]: "9199",
  [PRODUCT_SLUGS.crm]: "cc00",
  [PRODUCT_SLUGS.floriva]: "f10a",
};
function widgetKeyFor(slug: string): string {
  const suffix = WIDGET_KEY_SUFFIX[slug];
  if (!suffix) throw new Error(`no fixed widget key suffix configured for ${slug}`);
  return `wk_${"0".repeat(32 - suffix.length)}${suffix}`;
}

// Distinct product created_at so ProductsDB.list()'s ORDER BY created_at ASC
// is deterministic. The seed inserts all four products in one statement, so
// ties would otherwise be nondeterministic.
const PRODUCT_CREATED_AT_HOURS: Record<string, number> = {
  [PRODUCT_SLUGS.camaudit]: -24 * 400,
  [PRODUCT_SLUGS.grantpipe]: -24 * 390,
  [PRODUCT_SLUGS.crm]: -24 * 380,
  [PRODUCT_SLUGS.floriva]: -24 * 370,
};

// Frozen imported_at anchors for the reviews that Phase A imports over HTTP.
// scripts/demo/dataset.ts carries importedAtHours only for the rows Phase B
// inserts directly, so the manual/CSV rows get their offsets here: one anchor
// per source, minus one hour per row in dataset order. Every resulting value
// is distinct from every other review's, so the reviews list (ORDER BY
// imported_at DESC) is stable across runs.
const MANUAL_IMPORTED_AT_HOURS = -24 * 20;
const CSV_IMPORTED_AT_HOURS = -24 * 21;

// ---------------------------------------------------------------------------
// Guards. Every one of these runs before any network or SQL write happens.
// ---------------------------------------------------------------------------

function assertGuards(): { port: string } {
  const failures: string[] = [];

  if (process.env.VENTORA_DEMO_SEED !== "yes-fake-local-data") {
    failures.push(
      "VENTORA_DEMO_SEED must be set to 'yes-fake-local-data' to run this script (guard against accidental invocation).",
    );
  }

  let url: URL;
  try {
    url = new URL(BASE_URL);
  } catch {
    failures.push(`DEMO_BASE_URL is not a valid URL: ${BASE_URL}`);
    url = new URL("http://127.0.0.1:8788");
  }
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !isLoopback) {
    failures.push(
      `DEMO_BASE_URL must be http and loopback (127.0.0.1/localhost), got: ${BASE_URL}`,
    );
  }

  // The store this script writes to is the hardcoded DEMO_PERSIST_TO constant
  // above: every `wrangler` invocation below passes it literally, so there is
  // no caller-supplied store path to validate. What CAN vary is an inherited
  // D1_PERSIST_TO (scripts/demo-shots.ts sets it, scripts/seed-products.ts
  // reads it). If that disagrees with the demo store, the caller is expecting
  // writes somewhere this script will not write, so refuse.
  const envPersistTo = process.env.D1_PERSIST_TO;
  if (envPersistTo) {
    const resolvedEnv = resolve(envPersistTo);
    if (resolvedEnv === resolve(DEFAULT_PERSIST_TO)) {
      failures.push(
        `D1_PERSIST_TO points at the default local dev store (${resolvedEnv}); the demo tooling must never touch it.`,
      );
    } else if (resolvedEnv !== resolve(DEMO_PERSIST_TO)) {
      failures.push(`D1_PERSIST_TO must be unset or point at ${resolve(DEMO_PERSIST_TO)}, got: ${resolvedEnv}`);
    }
  }

  if (process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN) {
    failures.push("CF_API_TOKEN / CLOUDFLARE_API_TOKEN must not be set: this script is strictly local.");
  }

  if (failures.length > 0) {
    console.error("\n[seed-demo] refusing to run. Guard failures:\n");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("");
    process.exit(1);
  }

  return { port: url.port || "80" };
}

async function assertDevAuthBypass(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/me`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  if (!res.ok) {
    throw new Error(
      `GET /api/admin/me returned HTTP ${res.status}. Is DEV_AUTH_BYPASS=true set on the demo worker?`,
    );
  }
  const body: unknown = await res.json();
  const expected = JSON.stringify({ email: "dev@local" });
  const actual = JSON.stringify(body);
  if (actual !== expected) {
    throw new Error(
      `GET /api/admin/me must return exactly ${expected} under DEV_AUTH_BYPASS; got ${actual}. ` +
        "Refusing to seed: this would only happen against a real (prod-like) identity.",
    );
  }
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/admin/${path}`, {
    method: "POST",
    headers: CSRF_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /api/admin/${path} failed: HTTP ${res.status} ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/admin/${path}`, {
    method: "PATCH",
    headers: CSRF_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PATCH /api/admin/${path} failed: HTTP ${res.status} ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/admin/${path}`, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  if (!res.ok) throw new Error(`GET /api/admin/${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Phase B: direct SQL runner
// ---------------------------------------------------------------------------

function runSqlScript(sql: string): void {
  // mkdtempSync gives a fresh 0700 directory with a random suffix, so two
  // concurrent runs cannot collide on one filename and a pre-planted symlink
  // at a predictable path in the shared temp dir cannot be followed.
  const tmpDir = mkdtempSync(join(tmpdir(), "ventora-demo-seed-"));
  const tmpFile = join(tmpDir, "seed.sql");
  writeFileSync(tmpFile, sql, "utf-8");
  try {
    runWrangler(
      ["d1", "execute", "ventora-crm", "--local", "--persist-to", DEMO_PERSIST_TO, "--file", tmpFile],
      withLocalBin(),
    );
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* best-effort cleanup */
    }
  }
}

// ---------------------------------------------------------------------------
// Main seeding routine (assumes the demo worker is already reachable at BASE_URL)
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  // Re-run the guards here rather than trusting the caller. seed() is the
  // write path, and it is exported, so it must not be reachable without them.
  assertGuards();

  console.log(`[seed-demo] seeding against ${BASE_URL} ...`);

  interface ProductRow {
    id: string;
    slug: string;
  }
  const products = await apiGet<ProductRow[]>("settings/products");
  const productIdBySlug = new Map(products.map((p) => [p.slug, p.id]));
  for (const slug of Object.values(PRODUCT_SLUGS)) {
    if (!productIdBySlug.has(slug)) {
      throw new Error(`expected product '${slug}' to already be seeded (run demo-reset first)`);
    }
  }

  // --- Customers -----------------------------------------------------------
  console.log(`[seed-demo] creating ${CUSTOMERS.length} customers...`);
  const customerIdByKey = new Map<string, string>();
  for (const customer of CUSTOMERS) {
    const created = await apiPost<{ id: string }>("customers", {
      name: customer.name,
      email: customer.email,
      company: customer.company,
      role: customer.role,
      twitter: customer.twitter,
      linkedin: customer.linkedin,
      website: customer.website,
      lifecycle: customer.lifecycle,
      notes: customer.notes,
      product_ids: customer.productSlugs.map((slug) => productIdBySlug.get(slug)),
    });
    customerIdByKey.set(customer.key, created.id);
  }

  // --- Testimonials ----------------------------------------------------------
  console.log(`[seed-demo] creating ${TESTIMONIALS.length} testimonials...`);
  const testimonialIdByKey = new Map<string, string>();
  for (const t of TESTIMONIALS) {
    const customerId = customerIdByKey.get(t.customerKey);
    const productId = productIdBySlug.get(t.productSlug);
    if (!customerId || !productId) throw new Error(`testimonial ${t.key}: missing customer/product id`);
    const created = await apiPost<{ id: string }>("testimonials", {
      customer_id: customerId,
      product_id: productId,
      quote: t.quote,
      source: t.source,
      source_url: t.sourceUrl,
      rating: t.rating,
      approved: t.approved,
    });
    testimonialIdByKey.set(t.key, created.id);
    if (t.featured) {
      await apiPost(`testimonials/${created.id}/feature`, {});
    }
  }

  // --- Feedback --------------------------------------------------------------
  console.log(`[seed-demo] creating ${FEEDBACK_ITEMS.length} feedback items...`);
  const feedbackIdByKey = new Map<string, string>();
  for (const f of FEEDBACK_ITEMS) {
    const productId = productIdBySlug.get(f.productSlug);
    const customerId = f.customerKey ? customerIdByKey.get(f.customerKey) : undefined;
    if (!productId) throw new Error(`feedback ${f.key}: missing product id`);
    const created = await apiPost<{ id: string }>("feedback", {
      product_id: productId,
      type: f.type,
      title: f.title,
      body: f.body,
      customer_id: customerId,
    });
    feedbackIdByKey.set(f.key, created.id);
    if (f.status !== "new") {
      await apiPatch(`feedback/${created.id}/status`, { status: f.status });
    }
  }

  // --- Reviews: manual ---------------------------------------------------------
  console.log(`[seed-demo] importing ${MANUAL_REVIEWS.length} manual reviews...`);
  for (const r of MANUAL_REVIEWS) {
    const productId = productIdBySlug.get(r.productSlug);
    if (!productId) throw new Error(`manual review ${r.key}: missing product id`);
    await apiPost("reviews/import/manual", {
      product_id: productId,
      body: r.body,
      author_name: r.authorName,
      rating: r.rating,
      source_url: r.sourceUrl,
    });
  }

  // --- Reviews: csv ---------------------------------------------------------
  console.log(`[seed-demo] importing ${CSV_REVIEW_BATCHES.length} CSV review batches...`);
  for (const batch of CSV_REVIEW_BATCHES) {
    const productId = productIdBySlug.get(batch.productSlug);
    if (!productId) throw new Error(`csv batch ${batch.key}: missing product id`);
    const lines = [
      "author_name,body,rating,source_url",
      ...batch.rows.map((row) =>
        [
          csvCell(row.authorName),
          csvCell(row.body),
          row.rating === "" ? "" : String(row.rating),
          csvCell(row.sourceUrl ?? ""),
        ].join(","),
      ),
    ];
    await apiPost("reviews/import/csv", { product_id: productId, csv_text: lines.join("\n") });
  }

  // --- Connector configs -----------------------------------------------------
  console.log(`[seed-demo] creating ${CONNECTOR_CONFIGS.length} connector configs...`);
  const connectorIdByKey = new Map<string, string>();
  for (const cc of CONNECTOR_CONFIGS) {
    const productId = productIdBySlug.get(cc.productSlug);
    if (!productId) throw new Error(`connector config ${cc.key}: missing product id`);
    const created = await apiPost<{ id: string }>("reviews/connector-configs", {
      product_id: productId,
      source: cc.source,
      config: cc.config,
      enabled: cc.enabled,
    });
    connectorIdByKey.set(cc.key, created.id);
  }

  // ---------------------------------------------------------------------------
  // Phase B: direct SQL
  // ---------------------------------------------------------------------------
  console.log("[seed-demo] Phase B: freezing timestamps + widget keys via direct SQL...");

  const statements: string[] = [];

  // Freeze customer created_at/updated_at by natural key (email).
  for (const customer of CUSTOMERS) {
    const iso = frozenIso(customer.createdAtHours);
    statements.push(
      `UPDATE customers SET created_at = ${sqlString(iso)}, updated_at = ${sqlString(iso)} WHERE email = ${sqlString(customer.email)}`,
    );
  }

  // Freeze product widget_public_key + created_at by slug.
  for (const slug of Object.values(PRODUCT_SLUGS)) {
    statements.push(
      `UPDATE products SET widget_public_key = ${sqlString(widgetKeyFor(slug))}, created_at = ${sqlString(frozenIso(PRODUCT_CREATED_AT_HOURS[slug]!))} WHERE slug = ${sqlString(slug)}`,
    );
  }

  // Freeze testimonial created_at by id (captured from the API response above).
  for (const t of TESTIMONIALS) {
    const id = testimonialIdByKey.get(t.key);
    if (!id) continue;
    statements.push(`UPDATE testimonials SET created_at = ${sqlString(frozenIso(t.createdAtHours))} WHERE id = ${sqlString(id)}`);
  }

  // Set feedback upvotes + freeze created_at/updated_at by id.
  for (const f of FEEDBACK_ITEMS) {
    const id = feedbackIdByKey.get(f.key);
    if (!id) continue;
    const iso = frozenIso(f.createdAtHours);
    statements.push(
      `UPDATE feedback_items SET upvotes = ${sqlNumber(f.upvotes)}, created_at = ${sqlString(iso)}, updated_at = ${sqlString(iso)} WHERE id = ${sqlString(id)}`,
    );
  }

  // Freeze imported_at on the reviews Phase A imported over HTTP. Those rows
  // got a wall-clock imported_at from the real connectors, which is the one
  // thing in the fixture that would otherwise change on every run (and churn
  // docs/screenshots/19-reviews-imported-list.png). There is no id to capture
  // (the import endpoints return counts, not rows), so match on the natural
  // key (product_id, source, external_id) and recompute external_id exactly
  // the way src/connectors/manual.ts and src/connectors/csv.ts do.
  for (const [index, r] of MANUAL_REVIEWS.entries()) {
    const productId = productIdBySlug.get(r.productSlug);
    if (!productId) throw new Error(`manual review ${r.key}: missing product id`);
    const externalId = await sha256Hex(r.body + r.authorName);
    statements.push(
      `UPDATE reviews SET imported_at = ${sqlString(frozenIso(MANUAL_IMPORTED_AT_HOURS - index))} ` +
        `WHERE product_id = ${sqlString(productId)} AND source = 'manual' AND external_id = ${sqlString(externalId)}`,
    );
  }

  let csvRowIndex = 0;
  for (const batch of CSV_REVIEW_BATCHES) {
    const productId = productIdBySlug.get(batch.productSlug);
    if (!productId) throw new Error(`csv batch ${batch.key}: missing product id`);
    for (const row of batch.rows) {
      const sourceUrl = row.sourceUrl?.trim() ?? "";
      const externalId = await sha256Hex(
        [csvHashField(row.body), csvHashField(row.authorName), sourceUrl].join("|"),
      );
      statements.push(
        `UPDATE reviews SET imported_at = ${sqlString(frozenIso(CSV_IMPORTED_AT_HOURS - csvRowIndex))} ` +
          `WHERE product_id = ${sqlString(productId)} AND source = 'csv' AND external_id = ${sqlString(externalId)}`,
      );
      csvRowIndex++;
    }
  }

  // Insert rss/g2/trustpilot reviews directly (their API import paths hit the network).
  for (const r of SQL_REVIEWS) {
    const productId = productIdBySlug.get(r.productSlug);
    if (!productId) throw new Error(`sql review ${r.key}: missing product id`);
    const id = crypto.randomUUID();
    statements.push(
      `INSERT INTO reviews (id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at) ` +
        `VALUES (${sqlString(id)}, NULL, ${sqlString(productId)}, ${sqlString(r.source)}, ${sqlString(r.externalId)}, ${sqlNumber(r.rating)}, ${sqlString(r.body)}, ${sqlString(r.authorName)}, ${sqlString(r.sourceUrl)}, ${sqlString(frozenIso(r.importedAtHours))})`,
    );
  }

  // Freeze connector config last_status/last_polled_at/last_error/last_inserted.
  for (const cc of CONNECTOR_CONFIGS) {
    const id = connectorIdByKey.get(cc.key);
    if (!id) continue;
    const lastPolledAt = cc.lastPolledAtHours === null ? null : frozenIso(cc.lastPolledAtHours);
    statements.push(
      `UPDATE connector_configs SET last_polled_at = ${sqlString(lastPolledAt)}, last_status = ${sqlString(cc.lastStatus)}, last_error = ${sqlString(cc.lastError)}, last_inserted = ${sqlNumber(cc.lastInsertedAt)} WHERE id = ${sqlString(id)}`,
    );
  }

  runSqlScript(`BEGIN TRANSACTION;\n${statements.join(";\n")};\nCOMMIT;\n`);

  console.log(`[seed-demo] done. ${CUSTOMERS.length} customers, ${TESTIMONIALS.length} testimonials, ${FEEDBACK_ITEMS.length} feedback items, ${MANUAL_REVIEWS.length + CSV_REVIEW_BATCHES.reduce((n, b) => n + b.rows.length, 0) + SQL_REVIEWS.length} reviews, ${CONNECTOR_CONFIGS.length} connector configs.`,
  );
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Mirrors the per-field normalization in src/connectors/csv.ts's external_id
 * hash (lowercase, collapse runs of whitespace, trim). Must stay in lockstep
 * with that file or the imported_at freeze above silently matches no rows.
 */
function csvHashField(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Entry point. This script ALWAYS starts (and tears down) its own ephemeral
// wrangler dev server bound to the demo store, and refuses to run if anything
// is already listening at BASE_URL.
//
// Reusing a server we did not start is not safe here. A worker started by
// `npm run dev` runs against the DEFAULT .wrangler store, and under
// DEV_AUTH_BYPASS it answers /healthz and /api/admin/me identically to the
// demo worker, so no HTTP probe can tell the two apart. Seeding into it would
// write 12 fictional customers into the developer's real local dev database
// (Phase A) while Phase B wrote to .wrangler-demo: a split brain, and a
// violation of the "never touch the default store" rule in CLAUDE.md.
// Refusing is the only check that cannot be fooled.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { port } = assertGuards();

  const alreadyUp = await fetch(`${BASE_URL}/healthz`).then(
    (res) => {
      void res.body?.cancel();
      return true;
    },
    () => false,
  );

  if (alreadyUp) {
    console.error(
      `\n[seed-demo] refusing to run: something is already listening at ${BASE_URL}.\n\n` +
        "  This script only ever seeds a worker it started itself, because a server it\n" +
        "  did not start may be running against the default .wrangler store (for example\n" +
        "  `npm run dev`), and no HTTP check can tell that apart from the demo worker.\n\n" +
        `  Stop whatever owns port ${port} and re-run, or point DEMO_BASE_URL at a free\n` +
        "  loopback port.\n",
    );
    process.exit(1);
  }

  console.log(`[seed-demo] starting an ephemeral demo worker at ${BASE_URL} for seeding...`);
  const env = withLocalBin({ ...process.env });
  delete env.CF_API_TOKEN;
  delete env.CLOUDFLARE_API_TOKEN;
  const child = spawnWrangler(demoWranglerDevArgs(port, DEMO_PERSIST_TO), env);

  try {
    await waitForHttpUp(`${BASE_URL}/healthz`, 90_000);
    await assertDevAuthBypass();
    await seed();
  } finally {
    console.log("[seed-demo] stopping ephemeral seeding server...");
    await stopProcess(child);
    await killWhateverOwnsPort(port);
  }
}

if (process.argv[1] && process.argv[1].endsWith("seed-demo.ts")) {
  main().catch((err) => {
    console.error("[seed-demo] failed:", err);
    process.exit(1);
  });
}

export { assertGuards, seed };
