/**
 * Fix 2 — Opportunistic nonce-table pruning.
 *
 * Tests that after a successful ingest, nonce rows whose seen_at is older than
 * the HMAC skew window are removed, while a recent nonce (within the window)
 * is retained and still blocks replay (409).
 *
 * Uses the full worker.fetch() path via the real-D1 harness so the prune runs
 * in exactly the same code path as the production nonce INSERT.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";
import { buildHmacPayload, signHmacPayload } from "../../src/lib/sdr-hmac";
import type { StableJsonValue } from "../../src/lib/sdr-hmac";
import worker, { type Env } from "../../src/worker";

// ---------------------------------------------------------------------------
// Test constants (must match sdr-ingest.test.ts so the route resolves)
// ---------------------------------------------------------------------------

const TEST_SECRET = "test_crm_ingest_secret_for_unit_tests";
const TEST_PRODUCT_KEY = "test-product";
const TEST_PRODUCT_ID = "prod-test-nonce-prune";

const ingestPath = (productKey: string) => `/s/ingest/leads/${productKey}`;

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CRM_INGEST_SECRET: TEST_SECRET,
    MEDIA: {} as Env["MEDIA"],
    ASSETS: {
      fetch: async () => new Response("not found", { status: 404 }),
    } as unknown as Env["ASSETS"],
  };
}

async function seedProduct(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(TEST_PRODUCT_ID, TEST_PRODUCT_KEY, TEST_PRODUCT_KEY, "wk_prune_test", "[]", null)
    .run();
}

function validBody(sessionSuffix: string): StableJsonValue {
  return {
    sdrSessionId: `sess-prune-${sessionSuffix}`,
    profile: {
      contact: { name: "Prune Test", email: "prune@example.com", company: null, role: null },
      derived: {},
      qualification: {},
      fitScore: null,
      intentScore: null,
      status: "new",
    },
    activities: [],
    occurredAt: new Date().toISOString(),
  } as StableJsonValue;
}

async function buildSignedRequest(body: StableJsonValue, nonce: string): Promise<Request> {
  const path = ingestPath(TEST_PRODUCT_KEY);
  const timestamp = String(Date.now());
  const payload = await buildHmacPayload({ timestamp, nonce, method: "POST", path, body });
  const sig = await signHmacPayload(payload, TEST_SECRET);

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ventora-Signature": sig,
      "X-Ventora-Timestamp": timestamp,
      "X-Ventora-Nonce": nonce,
    },
    body: JSON.stringify(body),
  });
}

async function fetchWorker(req: Request, db: D1Database): Promise<Response> {
  return worker.fetch(req, makeEnv(db), {} as ExecutionContext);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let db: D1Database;

beforeEach(() => {
  db = createRealD1();
});

// ---------------------------------------------------------------------------
// Fix 2 tests
// ---------------------------------------------------------------------------

describe("nonce pruning — opportunistic prune on valid ingest (Fix 2)", () => {
  it("an old nonce row (seen_at before cutoff) is removed after a subsequent valid ingest", async () => {
    await seedProduct(db);

    // Insert a stale nonce directly — seen_at far in the past (10 minutes ago,
    // well beyond DEFAULT_MAX_SKEW_MS of 5 minutes plus any safety margin)
    const staleNonce = "stale-nonce-" + crypto.randomUUID();
    const staleSeenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db
      .prepare("INSERT INTO sdr_ingest_nonce (nonce, seen_at) VALUES (?, ?)")
      .bind(staleNonce, staleSeenAt)
      .run();

    // Confirm the stale row exists before the triggering ingest
    const before = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(staleNonce)
      .first<{ nonce: string }>();
    expect(before).not.toBeNull();

    // Perform a valid ingest — this should trigger the prune
    const freshNonce = crypto.randomUUID();
    const req = await buildSignedRequest(validBody(crypto.randomUUID()), freshNonce);
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);

    // Stale nonce row must be gone
    const after = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(staleNonce)
      .first<{ nonce: string }>();
    expect(after).toBeNull();

    // The fresh nonce that triggered the prune must still be present
    const freshRow = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(freshNonce)
      .first<{ nonce: string }>();
    expect(freshRow).not.toBeNull();
  });

  it("a recent nonce (within the window) is retained and still blocks replay (409)", async () => {
    await seedProduct(db);

    // First ingest — establishes a fresh nonce
    const recentNonce = crypto.randomUUID();
    const req1 = await buildSignedRequest(validBody(crypto.randomUUID()), recentNonce);
    const res1 = await fetchWorker(req1, db);
    expect(res1.status).toBe(200);

    // Insert a stale nonce and perform a second ingest to trigger pruning
    const staleNonce = "stale-nonce-recent-test-" + crypto.randomUUID();
    const staleSeenAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db
      .prepare("INSERT INTO sdr_ingest_nonce (nonce, seen_at) VALUES (?, ?)")
      .bind(staleNonce, staleSeenAt)
      .run();

    const triggerNonce = crypto.randomUUID();
    const req2 = await buildSignedRequest(validBody(crypto.randomUUID()), triggerNonce);
    const res2 = await fetchWorker(req2, db);
    expect(res2.status).toBe(200);

    // Stale nonce gone
    const staleRow = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(staleNonce)
      .first<{ nonce: string }>();
    expect(staleRow).toBeNull();

    // The recentNonce is still within the window — must still be present
    const recentRow = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(recentNonce)
      .first<{ nonce: string }>();
    expect(recentRow).not.toBeNull();

    // Replaying recentNonce must still return 409
    const replayReq = await buildSignedRequest(validBody(crypto.randomUUID()), recentNonce);
    const replayRes = await fetchWorker(replayReq, db);
    expect(replayRes.status).toBe(409);
    const json = await replayRes.json() as { error: string };
    expect(json.error).toMatch(/duplicate/i);
  });

  it("does NOT delete the just-inserted nonce (new nonce survives pruning)", async () => {
    await seedProduct(db);

    // Seed multiple stale nonces
    for (let i = 0; i < 3; i++) {
      await db
        .prepare("INSERT INTO sdr_ingest_nonce (nonce, seen_at) VALUES (?, ?)")
        .bind(`stale-multi-${i}-${crypto.randomUUID()}`, new Date(Date.now() - 15 * 60 * 1000).toISOString())
        .run();
    }

    const freshNonce = crypto.randomUUID();
    const req = await buildSignedRequest(validBody(crypto.randomUUID()), freshNonce);
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);

    // All stale nonces removed
    const remaining = await db
      .prepare("SELECT COUNT(*) AS n FROM sdr_ingest_nonce WHERE nonce LIKE 'stale-multi-%'")
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);

    // Fresh nonce must survive
    const freshRow = await db
      .prepare("SELECT nonce FROM sdr_ingest_nonce WHERE nonce = ?")
      .bind(freshNonce)
      .first<{ nonce: string }>();
    expect(freshRow).not.toBeNull();
  });
});
