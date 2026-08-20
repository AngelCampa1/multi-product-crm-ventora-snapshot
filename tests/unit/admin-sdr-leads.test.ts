/**
 * Task 1.5 — Admin SDR leads router tests.
 *
 * Uses the real-D1 harness (node:sqlite + all migrations) so every assertion
 * exercises real SQL: filters, pagination, joins, and JSON parsing.
 *
 * The router is exercised directly via router.request() — same pattern as the
 * other admin route test files. Auth middleware is NOT applied here because the
 * router file contains no auth; auth lives at the mount point in worker.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";
import sdrLeadsRouter from "../../src/routes/admin/sdr-leads";
import { SdrLeadsDB } from "../../src/db/sdr-leads";
import type { Env } from "../../src/worker";

// ---------------------------------------------------------------------------
// Env stub
// ---------------------------------------------------------------------------

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    CRM_INGEST_SECRET: "test-secret",
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
  opts: { id: string; slug: string; name?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(opts.id, opts.slug, opts.name ?? opts.slug, `wk_${opts.id}`, "[]", null)
    .run();
}

async function seedCustomer(
  db: D1Database,
  opts: { id: string; email: string; name?: string; company?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO customers (id, name, email, lifecycle, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.name ?? opts.email,
      opts.email,
      "lead",
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
    )
    .run();
}

async function seedLead(
  db: D1Database,
  opts: {
    id: string;
    customerId: string;
    productId: string;
    sessionId: string;
    status?: string;
    qualificationJson?: string | null;
    utmJson?: string | null;
    createdAt?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sdr_leads
         (id, customer_id, product_id, sdr_session_id, status,
          qualification_json, utm_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.customerId,
      opts.productId,
      opts.sessionId,
      opts.status ?? "new",
      opts.qualificationJson ?? null,
      opts.utmJson ?? null,
      opts.createdAt ?? "2024-01-01T00:00:00.000Z",
      opts.createdAt ?? "2024-01-01T00:00:00.000Z",
    )
    .run();
}

async function seedActivity(
  db: D1Database,
  opts: {
    id: string;
    leadId: string;
    type?: string;
    payloadJson?: string | null;
    occurredAt?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sdr_lead_activities (id, lead_id, type, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.leadId,
      opts.type ?? "session_started",
      opts.payloadJson ?? null,
      opts.occurredAt ?? "2024-01-01T00:00:00.000Z",
    )
    .run();
}

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

async function req(
  db: D1Database,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return sdrLeadsRouter.request(path, init, makeEnv(db));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: D1Database;

beforeEach(() => {
  db = createRealD1();
});

// ---------------------------------------------------------------------------
// GET / — list leads
// ---------------------------------------------------------------------------

describe("GET / — list leads", () => {
  it("returns empty list when no leads exist", async () => {
    const res = await req(db, "/");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("returns seeded leads with product_slug, product_name, and total", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one", name: "Product One" });
    await seedCustomer(db, { id: "c1", email: "alice@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "sess-1" });

    const res = await req(db, "/");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      items: Array<{ id: string; product_slug: string | null; product_name: string | null }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe("l1");
    expect(body.items[0]?.product_slug).toBe("prod-one");
    expect(body.items[0]?.product_name).toBe("Product One");
  });

  it("filters by product_id", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedProduct(db, { id: "p2", slug: "prod-two" });
    await seedCustomer(db, { id: "c1", email: "alice@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "sess-1" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p2", sessionId: "sess-2" });

    const res = await req(db, "/?product_id=p1");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe("l1");
  });

  it("filters by status", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "alice@test.com" });
    await seedCustomer(db, { id: "c2", email: "bob@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "sess-1", status: "new" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "sess-2", status: "qualified" });

    const res = await req(db, "/?status=qualified");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; status: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]?.id).toBe("l2");
    expect(body.items[0]?.status).toBe("qualified");
  });

  it("returns 400 for invalid status", async () => {
    const res = await req(db, "/?status=bogus");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("invalid lead status");
  });

  it("respects limit and offset — total reflects full count not the page slice", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedCustomer(db, { id: "c2", email: "b@test.com" });
    await seedCustomer(db, { id: "c3", email: "c@test.com" });
    // Created at different times so ORDER BY created_at DESC is deterministic
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "s2", createdAt: "2024-01-02T00:00:00.000Z" });
    await seedLead(db, { id: "l3", customerId: "c3", productId: "p1", sessionId: "s3", createdAt: "2024-01-03T00:00:00.000Z" });

    // First page: limit 2, offset 0 → newest two leads; total still 3
    const page1 = await req(db, "/?limit=2&offset=0");
    expect(page1.status).toBe(200);
    const body1 = await page1.json() as { items: Array<{ id: string }>; total: number };
    expect(body1.total).toBe(3);
    expect(body1.items).toHaveLength(2);
    // Newest first
    expect(body1.items[0]?.id).toBe("l3");
    expect(body1.items[1]?.id).toBe("l2");

    // Second page: limit 2, offset 2 → oldest lead
    const page2 = await req(db, "/?limit=2&offset=2");
    expect(page2.status).toBe(200);
    const body2 = await page2.json() as { items: Array<{ id: string }>; total: number };
    expect(body2.total).toBe(3);
    expect(body2.items).toHaveLength(1);
    expect(body2.items[0]?.id).toBe("l1");
  });

  it("clamps limit to MAX 200 and applies MIN 1", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    // No leads — just verify it doesn't error with extreme values
    const resHigh = await req(db, "/?limit=999");
    expect(resHigh.status).toBe(200);
    const resLow = await req(db, "/?limit=0");
    expect(resLow.status).toBe(200);
  });

  it("handles non-numeric limit/offset gracefully using fallback defaults", async () => {
    const res = await req(db, "/?limit=abc&offset=xyz");
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /:id — lead detail
// ---------------------------------------------------------------------------

describe("GET /:id — lead detail", () => {
  it("returns 404 for unknown id", async () => {
    const res = await req(db, "/lead-does-not-exist");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not found");
  });

  it("returns lead + customer + activities with parsed JSON columns", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "alice@test.com", name: "Alice" });
    await seedLead(db, {
      id: "l1",
      customerId: "c1",
      productId: "p1",
      sessionId: "sess-1",
      qualificationJson: JSON.stringify({ needPain: "yes" }),
      utmJson: JSON.stringify({ source: "google" }),
    });
    await seedActivity(db, {
      id: "a1",
      leadId: "l1",
      type: "session_started",
      payloadJson: JSON.stringify({ page: "/" }),
      occurredAt: "2024-01-01T01:00:00.000Z",
    });
    await seedActivity(db, {
      id: "a2",
      leadId: "l1",
      type: "qualification_updated",
      payloadJson: JSON.stringify({ score: 0.9 }),
      occurredAt: "2024-01-01T02:00:00.000Z",
    });

    const res = await req(db, "/l1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lead: {
        id: string;
        qualification: Record<string, unknown> | null;
        utm: Record<string, unknown> | null;
      };
      customer: { id: string; email: string; name: string } | null;
      activities: Array<{
        id: string;
        type: string;
        payload: Record<string, unknown> | null;
        occurred_at: string;
      }>;
    };

    // Lead with parsed JSON fields
    expect(body.lead.id).toBe("l1");
    expect(body.lead.qualification).toEqual({ needPain: "yes" });
    expect(body.lead.utm).toEqual({ source: "google" });

    // Customer included
    expect(body.customer).not.toBeNull();
    expect(body.customer?.id).toBe("c1");
    expect(body.customer?.email).toBe("alice@test.com");

    // Activities ordered oldest-first
    expect(body.activities).toHaveLength(2);
    expect(body.activities[0]?.id).toBe("a1");
    expect(body.activities[0]?.payload).toEqual({ page: "/" });
    expect(body.activities[1]?.id).toBe("a2");
    expect(body.activities[1]?.payload).toEqual({ score: 0.9 });
  });

  it("returns null qualification and utm when columns are null", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "bob@test.com" });
    await seedLead(db, {
      id: "l1",
      customerId: "c1",
      productId: "p1",
      sessionId: "sess-1",
      qualificationJson: null,
      utmJson: null,
    });

    const res = await req(db, "/l1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      lead: { qualification: null; utm: null };
      customer: unknown;
      activities: unknown[];
    };
    expect(body.lead.qualification).toBeNull();
    expect(body.lead.utm).toBeNull();
    expect(body.activities).toHaveLength(0);
  });

  it("returns null payload on activities that have null payload_json", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "carol@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "sess-1" });
    await seedActivity(db, { id: "a1", leadId: "l1", payloadJson: null });

    const res = await req(db, "/l1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      activities: Array<{ payload: null }>;
    };
    expect(body.activities[0]?.payload).toBeNull();
  });

  it("safeParseJson returns null on malformed JSON string", async () => {
    // Insert a lead row with deliberately malformed JSON (bypassing the ORM)
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "dave@test.com" });
    await seedLead(db, {
      id: "l1",
      customerId: "c1",
      productId: "p1",
      sessionId: "sess-1",
      qualificationJson: "not-valid-json{",
      utmJson: null,
    });

    const res = await req(db, "/l1");
    expect(res.status).toBe(200);
    const body = await res.json() as { lead: { qualification: null } };
    // Should not 500; malformed JSON returns null gracefully
    expect(body.lead.qualification).toBeNull();
  });

  it("safeParseJson returns null when JSON is a non-object (array)", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "eve@test.com" });
    await seedLead(db, {
      id: "l1",
      customerId: "c1",
      productId: "p1",
      sessionId: "sess-1",
      qualificationJson: "[1,2,3]",
      utmJson: null,
    });

    const res = await req(db, "/l1");
    expect(res.status).toBe(200);
    const body = await res.json() as { lead: { qualification: null } };
    expect(body.lead.qualification).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SdrLeadsDB.listLeads + countLeads — real-SQL coverage
// These tests exercise the new DB methods added for Task 1.5.
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.listLeads — real-SQL", () => {
  it("returns all leads across products when no filters given", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one", name: "Product One" });
    await seedProduct(db, { id: "p2", slug: "prod-two", name: "Product Two" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p2", sessionId: "s2" });

    const results = await SdrLeadsDB.listLeads(db);
    expect(results).toHaveLength(2);
    // product_slug and product_name are joined
    const p1Lead = results.find((r) => r.id === "l1");
    expect(p1Lead?.product_slug).toBe("prod-one");
    expect(p1Lead?.product_name).toBe("Product One");
  });

  it("filters by productId", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedProduct(db, { id: "p2", slug: "prod-two" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p2", sessionId: "s2" });

    const results = await SdrLeadsDB.listLeads(db, { productId: "p1" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("l1");
  });

  it("filters by status", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedCustomer(db, { id: "c2", email: "b@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", status: "new" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "s2", status: "qualified" });

    const results = await SdrLeadsDB.listLeads(db, { status: "qualified" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("l2");
  });

  it("filters by both productId and status", async () => {
    await seedProduct(db, { id: "p1", slug: "p1" });
    await seedProduct(db, { id: "p2", slug: "p2" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedCustomer(db, { id: "c2", email: "b@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", status: "new" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "s2", status: "qualified" });
    await seedLead(db, { id: "l3", customerId: "c1", productId: "p2", sessionId: "s3", status: "qualified" });

    const results = await SdrLeadsDB.listLeads(db, { productId: "p1", status: "qualified" });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("l2");
  });

  it("respects limit and offset", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p1", sessionId: "s2", createdAt: "2024-01-02T00:00:00.000Z" });
    await seedLead(db, { id: "l3", customerId: "c1", productId: "p1", sessionId: "s3", createdAt: "2024-01-03T00:00:00.000Z" });

    const page1 = await SdrLeadsDB.listLeads(db, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0]?.id).toBe("l3"); // newest first
    expect(page1[1]?.id).toBe("l2");

    const page2 = await SdrLeadsDB.listLeads(db, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0]?.id).toBe("l1");
  });

  it("returns empty array when no leads exist", async () => {
    const results = await SdrLeadsDB.listLeads(db);
    expect(results).toEqual([]);
  });
});

describe("SdrLeadsDB.countLeads — real-SQL", () => {
  it("returns 0 when no leads", async () => {
    const count = await SdrLeadsDB.countLeads(db);
    expect(count).toBe(0);
  });

  it("returns total without filters", async () => {
    await seedProduct(db, { id: "p1", slug: "prod-one" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p1", sessionId: "s2" });

    const count = await SdrLeadsDB.countLeads(db);
    expect(count).toBe(2);
  });

  it("counts with productId filter", async () => {
    await seedProduct(db, { id: "p1", slug: "p1" });
    await seedProduct(db, { id: "p2", slug: "p2" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1" });
    await seedLead(db, { id: "l2", customerId: "c1", productId: "p2", sessionId: "s2" });

    expect(await SdrLeadsDB.countLeads(db, { productId: "p1" })).toBe(1);
  });

  it("counts with status filter", async () => {
    await seedProduct(db, { id: "p1", slug: "p1" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedCustomer(db, { id: "c2", email: "b@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", status: "new" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "s2", status: "qualified" });

    expect(await SdrLeadsDB.countLeads(db, { status: "qualified" })).toBe(1);
  });

  it("counts with both productId and status filters", async () => {
    await seedProduct(db, { id: "p1", slug: "p1" });
    await seedProduct(db, { id: "p2", slug: "p2" });
    await seedCustomer(db, { id: "c1", email: "a@test.com" });
    await seedCustomer(db, { id: "c2", email: "b@test.com" });
    await seedLead(db, { id: "l1", customerId: "c1", productId: "p1", sessionId: "s1", status: "new" });
    await seedLead(db, { id: "l2", customerId: "c2", productId: "p1", sessionId: "s2", status: "qualified" });
    await seedLead(db, { id: "l3", customerId: "c1", productId: "p2", sessionId: "s3", status: "qualified" });

    expect(await SdrLeadsDB.countLeads(db, { productId: "p1", status: "qualified" })).toBe(1);
    expect(await SdrLeadsDB.countLeads(db, { productId: "p2", status: "qualified" })).toBe(1);
    expect(await SdrLeadsDB.countLeads(db, { productId: "p1" })).toBe(2);
  });
});
