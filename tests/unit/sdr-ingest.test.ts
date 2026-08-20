/**
 * Task 1.4 — SDR lead-ingest HTTP route tests.
 *
 * Uses the real-D1 harness (node:sqlite + all migrations) and drives the full
 * Hono worker via worker.fetch() at the canonical /s/ingest/leads/:productKey
 * path. This ensures the routing (mount point + HMAC path signing) matches
 * production exactly.
 *
 * Signing helpers are imported from src/lib/sdr-hmac.ts so every test uses
 * the exact same canonical payload logic as the verifier.
 *
 * validateLeadIngestBody is also tested in isolation (pure unit tests —
 * no HTTP, no D1) to maximise branch coverage of the validator.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";
import { buildHmacPayload, signHmacPayload } from "../../src/lib/sdr-hmac";
import type { StableJsonValue } from "../../src/lib/sdr-hmac";
import worker, { type Env } from "../../src/worker";
import { validateLeadIngestBody } from "../../src/routes/sdr-ingest/index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_SECRET = "test_crm_ingest_secret_for_unit_tests";
/**
 * TEST_PRODUCT_KEY is now a **slug** (e.g. "test-product"), matching what the
 * AI-SDR worker sends as the path segment. The route resolves by slug, NOT by
 * widget_public_key. The seeded product's slug must equal this value.
 */
const TEST_PRODUCT_KEY = "test-product";
const TEST_PRODUCT_ID = "prod-test-001";

/** Canonical full path — used for both HTTP requests AND HMAC signing. */
const ingestPath = (productKey: string) => `/s/ingest/leads/${productKey}`;

// ---------------------------------------------------------------------------
// Env stub — mimics only what the sdr-ingest route needs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProduct(
  db: D1Database,
  opts: {
    id?: string;
    slug?: string;
    widgetKey?: string;
    firewallGroup?: string | null;
  } = {},
): Promise<{ id: string; slug: string; widgetKey: string }> {
  const id = opts.id ?? TEST_PRODUCT_ID;
  // slug defaults to TEST_PRODUCT_KEY so the default path param resolves correctly.
  const slug = opts.slug ?? TEST_PRODUCT_KEY;
  // widgetKey is intentionally a DIFFERENT opaque value to prove resolution is by
  // slug, not by widget_public_key.
  const widgetKey = opts.widgetKey ?? "wk_opaque_unrelated_abc123";
  const firewallGroup = opts.firewallGroup ?? null;

  await db
    .prepare(
      `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, slug, slug, widgetKey, "[]", firewallGroup)
    .run();

  return { id, slug, widgetKey };
}

// ---------------------------------------------------------------------------
// Request builder helpers
// ---------------------------------------------------------------------------

interface SignedRequestOpts {
  body: StableJsonValue;
  productKey?: string;
  secret?: string;
  /** Override the path used in the HMAC payload (default: real path). */
  signingPath?: string;
  /** Override timestamp for skew tests (epoch ms as string). */
  timestamp?: string;
  /** Override nonce (default: random). */
  nonce?: string;
  /** Override signature entirely (to test bad-sig paths). */
  signature?: string;
  omitHeaders?: Array<"X-Ventora-Signature" | "X-Ventora-Timestamp" | "X-Ventora-Nonce">;
  contentLength?: string;
}

async function buildSignedRequest(opts: SignedRequestOpts): Promise<Request> {
  const productKey = opts.productKey ?? TEST_PRODUCT_KEY;
  const secret = opts.secret ?? TEST_SECRET;
  const path = ingestPath(productKey);
  const signingPath = opts.signingPath ?? path;
  const timestamp = opts.timestamp ?? String(Date.now());
  const nonce = opts.nonce ?? crypto.randomUUID();
  const bodyJson = JSON.stringify(opts.body);

  const payload = await buildHmacPayload({
    timestamp,
    nonce,
    method: "POST",
    path: signingPath,
    body: opts.body,
  });
  const computedSig = await signHmacPayload(payload, secret);
  const signature = opts.signature ?? computedSig;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.contentLength !== undefined) {
    headers["Content-Length"] = opts.contentLength;
  }
  if (!opts.omitHeaders?.includes("X-Ventora-Signature")) {
    headers["X-Ventora-Signature"] = signature;
  }
  if (!opts.omitHeaders?.includes("X-Ventora-Timestamp")) {
    headers["X-Ventora-Timestamp"] = timestamp;
  }
  if (!opts.omitHeaders?.includes("X-Ventora-Nonce")) {
    headers["X-Ventora-Nonce"] = nonce;
  }

  // Use http://localhost so URL.pathname works correctly in the handler.
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: bodyJson,
  });
}

/** Invoke worker.fetch with the correct signature (Request, Env, ExecutionContext) */
async function fetchWorker(req: Request, db: D1Database): Promise<Response> {
  return worker.fetch(req, makeEnv(db), {} as ExecutionContext);
}

// ---------------------------------------------------------------------------
// Minimal valid body factory
// ---------------------------------------------------------------------------

function validBody(overrides: Record<string, unknown> = {}): StableJsonValue {
  return {
    productKey: TEST_PRODUCT_KEY,
    sdrSessionId: "sess-test-" + crypto.randomUUID(),
    profile: {
      contact: {
        name: "Alice Test",
        email: "alice@example.com",
        company: "Acme Corp",
        role: "CTO",
      },
      qualification: {
        needPain: "Yes, they need it",
      },
      derived: {
        pageUrl: "https://acme.com/pricing",
        locale: "en-US",
        utm: { source: "google", medium: "cpc" },
      },
      fitScore: 0.85,
      intentScore: 0.7,
      status: "qualifying",
    },
    activities: [
      { type: "session_started", payload: { page: "/" } },
      { type: "qualification_updated", payload: { step: 1 } },
    ],
    occurredAt: new Date().toISOString(),
    ...overrides,
  } as StableJsonValue;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: D1Database;

beforeEach(() => {
  db = createRealD1();
});

// ---------------------------------------------------------------------------
// validateLeadIngestBody — unit tests (pure function, no HTTP)
// ---------------------------------------------------------------------------

describe("validateLeadIngestBody — pure validation", () => {
  it("accepts a valid full body", () => {
    const result = validateLeadIngestBody(validBody({ sdrSessionId: "sess-abc" }));
    expect(result.ok).toBe(true);
  });

  it("rejects non-object body", () => {
    const result = validateLeadIngestBody("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/object/i);
  });

  it("rejects missing sdrSessionId", () => {
    const body = validBody({ sdrSessionId: undefined });
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sdrSessionId/i);
  });

  it("rejects empty sdrSessionId", () => {
    const result = validateLeadIngestBody(validBody({ sdrSessionId: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/sdrSessionId/i);
  });

  it("rejects missing occurredAt", () => {
    const body = validBody({ occurredAt: undefined });
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/occurredAt/i);
  });

  it("rejects empty occurredAt", () => {
    const result = validateLeadIngestBody(validBody({ occurredAt: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/occurredAt/i);
  });

  it("rejects missing profile", () => {
    const body = validBody({ profile: undefined });
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/profile/i);
  });

  it("rejects non-object profile", () => {
    const result = validateLeadIngestBody(validBody({ profile: "bad" }));
    expect(result.ok).toBe(false);
  });

  it("rejects missing profile.contact", () => {
    const result = validateLeadIngestBody({
      ...(validBody() as Record<string, unknown>),
      profile: { qualification: {}, derived: {}, fitScore: 0.5 },
    } as StableJsonValue);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/contact/i);
  });

  it("rejects non-object profile.contact", () => {
    const result = validateLeadIngestBody({
      ...(validBody() as Record<string, unknown>),
      profile: { contact: "bad", derived: {}, qualification: {} },
    } as StableJsonValue);
    expect(result.ok).toBe(false);
  });

  it("rejects missing contact.email", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { name: "Alice" }, // no email
        qualification: {},
        derived: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/email/i);
  });

  it("rejects empty contact.email", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { name: "Alice", email: "" },
        qualification: {},
        derived: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/email/i);
  });

  it("rejects fitScore < 0", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        fitScore: -0.1,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fitScore/i);
  });

  it("rejects fitScore > 1", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        fitScore: 1.5,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/fitScore/i);
  });

  it("accepts fitScore at boundary 0", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        fitScore: 0,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    expect(validateLeadIngestBody(body).ok).toBe(true);
  });

  it("accepts fitScore at boundary 1", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        fitScore: 1,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    expect(validateLeadIngestBody(body).ok).toBe(true);
  });

  it("rejects intentScore out of [0,1]", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        intentScore: 2,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/intentScore/i);
  });

  it("rejects invalid profile.status enum", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        status: "bogus_status",
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/status/i);
  });

  it("rejects non-array activities", () => {
    const result = validateLeadIngestBody(validBody({ activities: "bad" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/activities/i);
  });

  it("rejects invalid activity type", () => {
    const result = validateLeadIngestBody(
      validBody({ activities: [{ type: "bad_type" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/activity type/i);
  });

  it("rejects non-object activity item", () => {
    const result = validateLeadIngestBody(
      validBody({ activities: ["not-an-object"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts empty activities array", () => {
    const result = validateLeadIngestBody(validBody({ activities: [] }));
    expect(result.ok).toBe(true);
  });

  it("accepts all valid activity types", () => {
    const types = [
      "session_started",
      "qualification_updated",
      "message_summary",
      "handoff_requested",
      "note",
    ];
    for (const type of types) {
      const result = validateLeadIngestBody(
        validBody({ activities: [{ type }] }),
      );
      expect(result.ok).toBe(true);
    }
  });

  it("accepts all valid status enum values", () => {
    const statuses = [
      "new",
      "qualifying",
      "qualified",
      "handoff_requested",
      "accepted",
      "disqualified",
    ];
    for (const status of statuses) {
      const body = {
        ...(validBody() as Record<string, unknown>),
        profile: {
          contact: { email: "a@b.com" },
          status,
          derived: {},
          qualification: {},
        },
      } as StableJsonValue;
      expect(validateLeadIngestBody(body).ok).toBe(true);
    }
  });

  it("uses name fallback to email local-part when name is absent", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "noname@b.com" },
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.customer.name).toBe("string");
      expect(result.value.customer.name.length).toBeGreaterThan(0);
      // Falls back to local-part of email
      expect(result.value.customer.name).toBe("noname");
    }
  });

  it("passes null for absent optional contact fields", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "minimal@b.com" },
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.customer.company).toBeNull();
      expect(result.value.customer.role).toBeNull();
    }
  });

  it("extracts utm/pageUrl/locale from profile.derived", () => {
    const result = validateLeadIngestBody(validBody({ sdrSessionId: "sess-derived" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead.utm).toEqual({ source: "google", medium: "cpc" });
      expect(result.value.lead.pageUrl).toBe("https://acme.com/pricing");
      expect(result.value.lead.locale).toBe("en-US");
    }
  });

  it("sets qualification to null when profile.qualification is absent", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        derived: {},
        // no qualification key
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead.qualification).toBeNull();
    }
  });

  it("sets qualification to null when profile.qualification is empty object", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead.qualification).toBeNull();
    }
  });

  it("defaults status to 'new' when not provided", () => {
    const body = {
      ...(validBody() as Record<string, unknown>),
      profile: {
        contact: { email: "a@b.com" },
        derived: {},
        qualification: {},
        // no status
      },
    } as StableJsonValue;
    const result = validateLeadIngestBody(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lead.status).toBe("new");
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests (via worker.fetch — uses full routing context)
// ---------------------------------------------------------------------------

describe("POST /s/ingest/leads/:productKey — misconfiguration guard", () => {
  it("returns 500 when CRM_INGEST_SECRET is not configured", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body });
    // Override env to omit the secret
    const envWithoutSecret = {
      ...makeEnv(db),
      CRM_INGEST_SECRET: undefined,
    } as unknown as Env;
    const res = await worker.fetch(req, envWithoutSecret, {} as ExecutionContext);
    expect(res.status).toBe(500);
  });

  it("returns 500 when CRM_INGEST_SECRET is all whitespace", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body });
    // An all-whitespace secret is truthy but must be treated as absent
    const envWhitespaceSecret = {
      ...makeEnv(db),
      CRM_INGEST_SECRET: "   ",
    } as unknown as Env;
    const res = await worker.fetch(req, envWhitespaceSecret, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/misconfiguration/i);
  });
});

describe("POST /s/ingest/leads/:productKey — happy path", () => {
  it("returns 200 with customerId, leadId, status on valid request", async () => {
    await seedProduct(db);
    const body = validBody({ sdrSessionId: "sess-happy-001" });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json["customerId"]).toBe("string");
    expect(typeof json["leadId"]).toBe("string");
    expect(typeof json["status"]).toBe("string");
  });

  it("persists lead and customer rows in D1", async () => {
    await seedProduct(db);
    const sessionId = "sess-persist-" + crypto.randomUUID();
    const body = validBody({ sdrSessionId: sessionId });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as { customerId: string; leadId: string };

    const lead = await db
      .prepare("SELECT * FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ id: string; sdr_session_id: string; status: string }>();
    expect(lead).not.toBeNull();
    expect(lead?.sdr_session_id).toBe(sessionId);

    const customer = await db
      .prepare("SELECT * FROM customers WHERE id = ?")
      .bind(json.customerId)
      .first<{ id: string; email: string }>();
    expect(customer).not.toBeNull();
    expect(customer?.email).toBe("alice@example.com");
  });

  it("appends activities to D1", async () => {
    await seedProduct(db);
    const sessionId = "sess-act-" + crypto.randomUUID();
    const body = validBody({
      sdrSessionId: sessionId,
      activities: [
        { type: "session_started" },
        { type: "qualification_updated", payload: { step: 2 } },
      ],
    });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as { leadId: string };

    const acts = await db
      .prepare("SELECT * FROM sdr_lead_activities WHERE lead_id = ? ORDER BY occurred_at ASC")
      .bind(json.leadId)
      .all<{ type: string; payload_json: string | null }>();
    expect(acts.results).toHaveLength(2);
    expect(acts.results[0]?.type).toBe("session_started");
    expect(acts.results[1]?.type).toBe("qualification_updated");
  });

  it("records source as 'ai-sdr'", async () => {
    await seedProduct(db);
    const sessionId = "sess-source-" + crypto.randomUUID();
    const body = validBody({ sdrSessionId: sessionId });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as { leadId: string };

    const lead = await db
      .prepare("SELECT source FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ source: string }>();
    expect(lead?.source).toBe("ai-sdr");
  });

  it("persists fit_score, intent_score, and status to sdr_leads", async () => {
    // Regression guard: a wiring bug that dropped fitScore/intentScore between
    // the route handler and upsertLeadBySession would leave fit_score/intent_score
    // null in D1, failing the assertions below.
    await seedProduct(db);
    const sessionId = "sess-scores-" + crypto.randomUUID();
    // validBody() already sets fitScore: 0.85, intentScore: 0.7, status: "qualifying"
    const body = validBody({ sdrSessionId: sessionId });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as { leadId: string };

    const row = await db
      .prepare("SELECT fit_score, intent_score, status FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ fit_score: number; intent_score: number; status: string }>();
    expect(row).not.toBeNull();
    // The route passes parsed.lead.fitScore / intentScore directly to upsertLeadBySession;
    // the DB column names are fit_score / intent_score. Assert exact values.
    expect(row?.fit_score).toBe(0.85);
    expect(row?.intent_score).toBe(0.7);
    // The route trusts the incoming profile.status ("qualifying") — no server-side
    // re-computation. Assert the value that validBody() sends.
    expect(row?.status).toBe("qualifying");
  });
});

describe("POST /s/ingest/leads/:productKey — idempotency", () => {
  it("second call with same sdrSessionId but different nonce returns 200 with only ONE sdr_lead row", async () => {
    await seedProduct(db);
    const sessionId = "sess-idempotent-" + crypto.randomUUID();
    const body = validBody({ sdrSessionId: sessionId });

    const req1 = await buildSignedRequest({ body });
    const res1 = await fetchWorker(req1, db);
    expect(res1.status).toBe(200);

    const req2 = await buildSignedRequest({ body }); // new nonce auto-generated
    const res2 = await fetchWorker(req2, db);
    expect(res2.status).toBe(200);

    const count = await db
      .prepare("SELECT COUNT(*) as n FROM sdr_leads WHERE sdr_session_id = ?")
      .bind(sessionId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("POST /s/ingest/leads/:productKey — replay protection", () => {
  it("first request 200, second request with SAME nonce → 409", async () => {
    await seedProduct(db);
    const nonce = crypto.randomUUID();
    const body = validBody({ sdrSessionId: "sess-replay-" + crypto.randomUUID() });
    const body2 = validBody({ sdrSessionId: "sess-replay2-" + crypto.randomUUID() });

    const req1 = await buildSignedRequest({ body, nonce });
    const res1 = await fetchWorker(req1, db);
    expect(res1.status).toBe(200);

    const req2 = await buildSignedRequest({ body: body2, nonce }); // same nonce, signed correctly
    const res2 = await fetchWorker(req2, db);
    expect(res2.status).toBe(409);
    const json2 = await res2.json() as { error: string };
    expect(json2.error).toMatch(/duplicate/i);
  });

  it("bad-body request does NOT consume the nonce — valid retry with same nonce still succeeds (Fix 1)", async () => {
    // This test proves the reorder: body validation (→400) happens before nonce INSERT (→409).
    // A request with a valid signature but invalid body must not burn the nonce,
    // so a subsequent valid request reusing the same nonce must succeed with 200.
    await seedProduct(db);
    const nonce = crypto.randomUUID();

    // First request: valid signature, INVALID body (missing sdrSessionId)
    const badBody = validBody({ sdrSessionId: undefined });
    const req1 = await buildSignedRequest({ body: badBody, nonce });
    const res1 = await fetchWorker(req1, db);
    expect(res1.status).toBe(400); // validation rejects before nonce is consumed

    // Second request: same nonce, valid body — must succeed, not 409
    const goodBody = validBody({ sdrSessionId: "sess-retry-" + crypto.randomUUID() });
    const req2 = await buildSignedRequest({ body: goodBody, nonce });
    const res2 = await fetchWorker(req2, db);
    expect(res2.status).toBe(200); // nonce was NOT consumed by the bad-body request
  });
});

describe("POST /s/ingest/leads/:productKey — authentication failures", () => {
  it("returns 401 when X-Ventora-Signature header is missing", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body, omitHeaders: ["X-Ventora-Signature"] });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Ventora-Timestamp header is missing", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body, omitHeaders: ["X-Ventora-Timestamp"] });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Ventora-Nonce header is missing", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body, omitHeaders: ["X-Ventora-Nonce"] });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
  });

  it("returns 401 when signature is wrong", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({
      body,
      signature: "a".repeat(64), // 64-char hex but wrong value
    });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/invalid signature/i);
  });

  it("returns 401 for a stale timestamp (10 minutes ago)", async () => {
    await seedProduct(db);
    const body = validBody();
    const staleTs = String(Date.now() - 10 * 60 * 1000);
    const req = await buildSignedRequest({ body, timestamp: staleTs });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
  });

  it("does not expose HMAC reason detail in the response body", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({ body, signature: "b".repeat(64) });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/malformed/i);
    expect(text).not.toMatch(/timestamp_skew/i);
  });
});

describe("POST /s/ingest/leads/:productKey — product lookup", () => {
  it("returns 404 for an unknown product slug (valid signature)", async () => {
    // Don't seed any product — "no-such-slug" is not in the DB.
    const body = validBody({ productKey: "no-such-slug" });
    const req = await buildSignedRequest({ body, productKey: "no-such-slug" });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/unknown product/i);
  });

  it("REGRESSION — resolves product by slug, NOT by widget_public_key", async () => {
    // Seeds a product whose slug is "grantpipe" but whose widget_public_key is
    // a DIFFERENT opaque value. The route must resolve by slug so that the
    // AI-SDR worker's path segment (the slug) finds the product. Under the old
    // getByWidgetKey() code this request would return 404 and the lead would be
    // silently dropped. Under the correct getBySlug() code it returns 200.
    await seedProduct(db, {
      id: "prod-grantpipe",
      slug: "grantpipe",
      widgetKey: "wk_unrelated_xyz",
    });

    const body = validBody({
      sdrSessionId: "sess-regression-slug-" + crypto.randomUUID(),
      productKey: "grantpipe",
    });
    const req = await buildSignedRequest({ body, productKey: "grantpipe" });
    const res = await fetchWorker(req, db);

    // Must be 200 (lead lands) — would be 404 with the old getByWidgetKey() code
    expect(res.status).toBe(200);
    const json = await res.json() as { customerId: string; leadId: string; status: string };
    expect(typeof json.customerId).toBe("string");
    expect(typeof json.leadId).toBe("string");

    // Confirm the lead row actually landed in D1
    const lead = await db
      .prepare("SELECT id FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ id: string }>();
    expect(lead).not.toBeNull();
  });

  it("ALIAS — resolves the AI-SDR key 'camaudit' to the CRM slug 'camaudit-v2'", async () => {
    // The AI-SDR worker sends path segment "camaudit" (CAMAudit's immutable
    // AI-SDR product key), but the CRM stores the product under slug
    // "camaudit-v2". The ingest route must apply the alias so the lead lands.
    // Without the alias resolver this returns 404 and the lead is dropped.
    await seedProduct(db, {
      id: "prod-camaudit",
      slug: "camaudit-v2",
      widgetKey: "wk_camaudit_unrelated",
    });

    const body = validBody({
      sdrSessionId: "sess-alias-camaudit-" + crypto.randomUUID(),
      productKey: "camaudit",
    });
    const req = await buildSignedRequest({ body, productKey: "camaudit" });
    const res = await fetchWorker(req, db);

    // Must be 200 — would be 404 without the alias (slug "camaudit" not in DB).
    expect(res.status).toBe(200);
    const json = await res.json() as { customerId: string; leadId: string; status: string };
    expect(typeof json.leadId).toBe("string");

    // Confirm the lead row landed AND is linked to the camaudit-v2 product.
    const lead = await db
      .prepare("SELECT id, product_id FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ id: string; product_id: string }>();
    expect(lead).not.toBeNull();
    expect(lead?.product_id).toBe("prod-camaudit");
  });
});

describe("POST /s/ingest/leads/:productKey — size limits", () => {
  it("returns 413 when Content-Length header exceeds 32KB", async () => {
    await seedProduct(db);
    const body = validBody();
    const req = await buildSignedRequest({
      body,
      contentLength: String(33 * 1024),
    });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(413);
  });

  it("returns 413 when body stream exceeds 32KB", async () => {
    await seedProduct(db);
    // Build a body that is actually over 32KB
    const hugeBody = {
      productKey: TEST_PRODUCT_KEY,
      sdrSessionId: "sess-huge-" + crypto.randomUUID(),
      profile: {
        contact: { email: "a@b.com", name: "A".repeat(40_000) },
        derived: {},
        qualification: {},
      },
      activities: [],
      occurredAt: new Date().toISOString(),
    };
    const bodyJson = JSON.stringify(hugeBody);
    const nonce = crypto.randomUUID();
    const timestamp = String(Date.now());

    const payload = await buildHmacPayload({
      timestamp,
      nonce,
      method: "POST",
      path: ingestPath(TEST_PRODUCT_KEY),
      body: hugeBody as unknown as StableJsonValue,
    });
    const sig = await signHmacPayload(payload, TEST_SECRET);

    const req = new Request(`http://localhost${ingestPath(TEST_PRODUCT_KEY)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ventora-Signature": sig,
        "X-Ventora-Timestamp": timestamp,
        "X-Ventora-Nonce": nonce,
      },
      body: bodyJson,
    });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(413);
  });
});

describe("POST /s/ingest/leads/:productKey — body validation failures (via HTTP)", () => {
  it("returns 400 for invalid JSON body", async () => {
    // Per the handler order: body is read first (step 2), so invalid JSON → 400
    // before HMAC is ever checked.
    await seedProduct(db);
    const nonce = crypto.randomUUID();
    const timestamp = String(Date.now());
    // Compute a valid-looking sig over an empty object (doesn't matter — 400 fires first)
    const payload = await buildHmacPayload({
      timestamp, nonce, method: "POST",
      path: ingestPath(TEST_PRODUCT_KEY),
      body: {},
    });
    const sig = await signHmacPayload(payload, TEST_SECRET);

    const req = new Request(`http://localhost${ingestPath(TEST_PRODUCT_KEY)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ventora-Signature": sig,
        "X-Ventora-Timestamp": timestamp,
        "X-Ventora-Nonce": nonce,
      },
      body: "not valid json {{{",
    });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing sdrSessionId", async () => {
    await seedProduct(db);
    const body = validBody({ sdrSessionId: undefined });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing contact.email", async () => {
    await seedProduct(db);
    const body = {
      ...(validBody() as Record<string, unknown>),
      sdrSessionId: "sess-noemail-" + crypto.randomUUID(),
      profile: {
        contact: { name: "Alice" }, // no email
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });

  it("returns 400 for fitScore out of [0,1]", async () => {
    await seedProduct(db);
    const body = {
      ...(validBody() as Record<string, unknown>),
      sdrSessionId: "sess-fitbad-" + crypto.randomUUID(),
      profile: {
        contact: { email: "a@b.com" },
        fitScore: 2.5,
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid activity type", async () => {
    await seedProduct(db);
    const body = validBody({
      sdrSessionId: "sess-badact-" + crypto.randomUUID(),
      activities: [{ type: "evil_type" }],
    });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid profile.status", async () => {
    await seedProduct(db);
    const body = {
      ...(validBody() as Record<string, unknown>),
      sdrSessionId: "sess-badstatus-" + crypto.randomUUID(),
      profile: {
        contact: { email: "a@b.com" },
        status: "not_a_real_status",
        derived: {},
        qualification: {},
      },
    } as StableJsonValue;
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(400);
  });
});

describe("POST /s/ingest/leads/:productKey — empty activities", () => {
  it("returns 200 with no activities in the request (0 activity rows appended)", async () => {
    await seedProduct(db);
    const sessionId = "sess-noact-" + crypto.randomUUID();
    const body = validBody({ sdrSessionId: sessionId, activities: [] });
    const req = await buildSignedRequest({ body });
    const res = await fetchWorker(req, db);
    expect(res.status).toBe(200);
    const json = await res.json() as { leadId: string };

    const acts = await db
      .prepare("SELECT COUNT(*) as n FROM sdr_lead_activities WHERE lead_id = ?")
      .bind(json.leadId)
      .first<{ n: number }>();
    expect(acts?.n).toBe(0);
  });
});

describe("POST /s/ingest/leads/:productKey — persistence failure (Fix 2)", () => {
  it("returns 500 with { error: 'internal error' } when DB throws during persist — no stack/PII in body", async () => {
    // Seed the product in the real DB so product lookup succeeds.
    await seedProduct(db);

    // Build a fake D1Database that succeeds for the nonce INSERT (so we reach
    // the persistence try/catch) but throws for any subsequent prepare call.
    // The first two prepare calls are: (1) product lookup, (2) nonce INSERT —
    // both must succeed. The third call is the first persistence statement and
    // must throw to exercise the try/catch.
    let prepareCallCount = 0;
    const fakeDB: D1Database = {
      prepare(sql: string) {
        prepareCallCount += 1;
        if (prepareCallCount <= 2) {
          // Product lookup (1) + nonce INSERT (2) — delegate to real DB.
          return db.prepare(sql);
        }
        // Third call and beyond is inside the persistence block — throw.
        throw new Error("simulated D1 persistence failure");
      },
    } as unknown as D1Database;

    const body = validBody({ sdrSessionId: "sess-persist-fail-" + crypto.randomUUID() });
    const req = await buildSignedRequest({ body });

    const envWithFakeDB = {
      ...makeEnv(db),
      DB: fakeDB,
    } as unknown as Env;

    const res = await worker.fetch(req, envWithFakeDB, {} as ExecutionContext);
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    // Body must be the clean internal error message — no stack trace, no PII
    expect(json.error).toBe("internal error");
    expect(JSON.stringify(json)).not.toMatch(/simulated/i);
    expect(JSON.stringify(json)).not.toMatch(/stack/i);
    expect(JSON.stringify(json)).not.toMatch(/alice/i);

    // Confirm we actually exercised at least 3 prepare calls
    expect(prepareCallCount).toBeGreaterThanOrEqual(3);
  });
});

describe("POST /s/ingest/leads/:productKey — firewall block path", () => {
  it("still returns 200 and persists lead when linkProductFirewallSafe returns false", async () => {
    // Seed two products in same firewall group. The path param is the slug
    // (e.g. "cre-a"), NOT the widget_public_key.
    await seedProduct(db, {
      id: "prod-cre-a",
      slug: "cre-a",
      widgetKey: "wk_cre_a_opaque",
      firewallGroup: "cre",
    });
    await seedProduct(db, {
      id: "prod-cre-b",
      slug: "cre-b",
      widgetKey: "wk_cre_b_opaque",
      firewallGroup: "cre",
    });

    // First ingest for product A — links customer to cre-a (path param = slug)
    const email = "firewall-test@example.com";
    const bodyA = {
      productKey: "cre-a",
      sdrSessionId: "sess-fw-a-" + crypto.randomUUID(),
      profile: {
        contact: { email, name: "FW Test" },
        derived: {},
        qualification: {},
      },
      activities: [],
      occurredAt: new Date().toISOString(),
    } as StableJsonValue;

    const reqA = await buildSignedRequest({ body: bodyA, productKey: "cre-a" });
    const resA = await fetchWorker(reqA, db);
    expect(resA.status).toBe(200);

    // Second ingest for product B — firewall should block the link but lead persists
    const bodyB = {
      productKey: "cre-b",
      sdrSessionId: "sess-fw-b-" + crypto.randomUUID(),
      profile: {
        contact: { email, name: "FW Test" },
        derived: {},
        qualification: {},
      },
      activities: [],
      occurredAt: new Date().toISOString(),
    } as StableJsonValue;

    const reqB = await buildSignedRequest({ body: bodyB, productKey: "cre-b" });
    const resB = await fetchWorker(reqB, db);
    expect(resB.status).toBe(200);

    const json = await resB.json() as { leadId: string };
    const lead = await db
      .prepare("SELECT id FROM sdr_leads WHERE id = ?")
      .bind(json.leadId)
      .first<{ id: string }>();
    expect(lead).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 1.6 — router.onError backstop
//
// Forces a throw at step 8 (nonce INSERT) — the one DB call that is NOT inside
// the persistence try/catch — and asserts the onError handler returns a clean
// 500 with no stack trace or PII. Uses worker.fetch so the full Hono router
// (including onError) is active.
// ---------------------------------------------------------------------------

describe("POST /s/ingest/leads/:productKey — onError backstop (Task 1.6)", () => {
  it("returns 500 { error: 'internal error' } when nonce INSERT throws — no stack/PII in body", async () => {
    // Seed the product in the real DB so product lookup (prepare call 1) succeeds.
    await seedProduct(db);

    // Prepare call order in the happy path up to step 8:
    //   1. ProductsDB.getBySlug → SELECT (prepare #1)
    //   2. nonce INSERT (prepare #2) — we make this throw
    let prepareCallCount = 0;
    const fakeDB: D1Database = {
      prepare(sql: string) {
        prepareCallCount += 1;
        if (prepareCallCount === 1) {
          // Product lookup — delegate to real DB so it returns the seeded product.
          return db.prepare(sql);
        }
        // Second call is the nonce INSERT. Throw synchronously to bypass step 8
        // without entering the persistence try/catch at step 9.
        throw new Error("simulated nonce INSERT failure — should never appear in body");
      },
    } as unknown as D1Database;

    const body = validBody({ sdrSessionId: "sess-onceerror-" + crypto.randomUUID() });
    const reqObj = await buildSignedRequest({ body });

    const envWithFakeDB = { ...makeEnv(db), DB: fakeDB } as unknown as Env;
    const res = await worker.fetch(reqObj, envWithFakeDB, {} as ExecutionContext);

    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };

    // The body must be the clean message from onError — no stack, no error details, no PII
    expect(json.error).toBe("internal error");
    expect(JSON.stringify(json)).not.toMatch(/simulated/i);
    expect(JSON.stringify(json)).not.toMatch(/stack/i);
    expect(JSON.stringify(json)).not.toMatch(/alice/i);
    expect(JSON.stringify(json)).not.toMatch(/nonce/i);

    // Confirm exactly 2 prepare calls were made (product lookup + nonce attempt)
    expect(prepareCallCount).toBe(2);
  });

  it("onError path produces JSON content-type and no body beyond { error } key", async () => {
    await seedProduct(db);

    let prepareCallCount = 0;
    const fakeDB: D1Database = {
      prepare(sql: string) {
        prepareCallCount += 1;
        if (prepareCallCount === 1) return db.prepare(sql);
        throw new Error("another nonce failure");
      },
    } as unknown as D1Database;

    const body = validBody({ sdrSessionId: "sess-onceerror2-" + crypto.randomUUID() });
    const reqObj = await buildSignedRequest({ body });
    const envWithFakeDB = { ...makeEnv(db), DB: fakeDB } as unknown as Env;

    const res = await worker.fetch(reqObj, envWithFakeDB, {} as ExecutionContext);
    expect(res.status).toBe(500);

    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("application/json");

    const json = await res.json() as Record<string, unknown>;
    // Only the 'error' key is present — no extra fields leaking internal state
    expect(Object.keys(json)).toEqual(["error"]);
    expect(prepareCallCount).toBe(2);
  });
});
