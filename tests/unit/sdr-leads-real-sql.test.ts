/**
 * Real-SQL tests for migration 0010 + SdrLeadsDB.
 *
 * Uses the node:sqlite-backed harness (tests/helpers/real-d1.ts) to run
 * actual SQL against the full migration chain. This catches bugs that
 * vi.fn() mocks cannot: CHECK constraint violations, UNIQUE conflicts,
 * ON DELETE CASCADE/RESTRICT behaviour, ON CONFLICT idempotency, and the
 * firewall subquery guard logic.
 *
 * The existing mock-based tests (sdr-leads-db.test.ts) are kept for cheap
 * branch coverage; this file adds the real-engine layer on top.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";
import { SdrLeadsDB } from "../../src/db/sdr-leads";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProduct(
  db: D1Database,
  opts: { id: string; slug: string; name?: string; firewallGroup?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.slug,
      opts.name ?? opts.slug,
      `wk_test_${opts.id}`,
      "[]",
      opts.firewallGroup ?? null,
    )
    .run();
}

async function seedCustomer(
  db: D1Database,
  opts: { id: string; email: string; name?: string },
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

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: D1Database;

beforeEach(() => {
  db = createRealD1();
});

// ---------------------------------------------------------------------------
// STEP 2 — Schema / constraint tests against the real engine
// ---------------------------------------------------------------------------

describe("real-SQL schema — sdr_leads CHECK constraint (status)", () => {
  it("rejects status='bogus' — CHECK enforced by real SQLite", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedCustomer(db, { id: "c1", email: "alice@example.com" });

    await expect(
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("l1", "c1", "p1", "sess-bad-status", "bogus", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});

describe("real-SQL schema — sdr_lead_activities CHECK constraint (type)", () => {
  it("rejects type='bogus' — CHECK enforced by real SQLite", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedCustomer(db, { id: "c1", email: "alice@example.com" });
    await db
      .prepare(
        `INSERT INTO sdr_leads
         (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("l1", "c1", "p1", "sess-1", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();

    await expect(
      db
        .prepare("INSERT INTO sdr_lead_activities (id, lead_id, type, occurred_at) VALUES (?, ?, ?, ?)")
        .bind("a1", "l1", "bogus", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});

describe("real-SQL schema — sdr_session_id UNIQUE constraint", () => {
  it("rejects a duplicate sdr_session_id — UNIQUE enforced", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedCustomer(db, { id: "c1", email: "alice@example.com" });

    const insertLead = (id: string) =>
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, "c1", "p1", "sess-dup", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run();

    await insertLead("l1");
    await expect(insertLead("l2")).rejects.toThrow();
  });
});

describe("real-SQL schema — FK: non-existent customer_id", () => {
  it("rejects sdr_leads insert with non-existent customer_id — FK enforced", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });

    await expect(
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("l1", "ghost-customer", "p1", "sess-1", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});

describe("real-SQL schema — ON DELETE CASCADE: customer → sdr_leads → sdr_lead_activities", () => {
  it("cascades customer delete through sdr_leads to sdr_lead_activities", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedCustomer(db, { id: "c1", email: "alice@example.com" });

    await db
      .prepare(
        `INSERT INTO sdr_leads
         (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("l1", "c1", "p1", "sess-1", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();
    await db
      .prepare("INSERT INTO sdr_lead_activities (id, lead_id, type, occurred_at) VALUES (?, ?, ?, ?)")
      .bind("a1", "l1", "session_started", "2024-01-01T00:00:00.000Z")
      .run();

    // Verify rows exist before delete
    const leadBefore = await db.prepare("SELECT id FROM sdr_leads WHERE id = ?").bind("l1").first<{ id: string }>();
    expect(leadBefore).not.toBeNull();
    const actBefore = await db.prepare("SELECT id FROM sdr_lead_activities WHERE id = ?").bind("a1").first<{ id: string }>();
    expect(actBefore).not.toBeNull();

    // Delete the customer — should cascade
    await db.prepare("DELETE FROM customers WHERE id = ?").bind("c1").run();

    const leadAfter = await db.prepare("SELECT id FROM sdr_leads WHERE id = ?").bind("l1").first();
    expect(leadAfter).toBeNull();
    const actAfter = await db.prepare("SELECT id FROM sdr_lead_activities WHERE id = ?").bind("a1").first();
    expect(actAfter).toBeNull();
  });
});

describe("real-SQL schema — ON DELETE RESTRICT: product → sdr_leads", () => {
  it("prevents deleting a product that still has an sdr_lead referencing it", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedCustomer(db, { id: "c1", email: "alice@example.com" });
    await db
      .prepare(
        `INSERT INTO sdr_leads
         (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("l1", "c1", "p1", "sess-1", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();

    await expect(
      db.prepare("DELETE FROM products WHERE id = ?").bind("p1").run(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SdrLeadsDB idempotency / logic tests — through the real engine
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.upsertLeadBySession — real-SQL idempotency", () => {
  it("second call with same sdrSessionId returns exactly ONE row and updates mutable fields", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice",
      email: "alice@test.com",
      company: null,
      role: null,
    });

    const firstCall = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-idempotent",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    // Slight delay so updated_at differs from created_at
    await new Promise((r) => setTimeout(r, 5));

    const secondCall = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-idempotent",
      status: "qualifying",
      qualification: { intent: "high" },
      fitScore: 0.9,
      intentScore: 0.8,
      summary: "Good fit",
      source: "widget",
      utm: null,
      pageUrl: "https://example.com",
      locale: "en-US",
    });

    // Verify exactly ONE row in the DB for this session
    const allLeads = await db
      .prepare("SELECT id FROM sdr_leads WHERE sdr_session_id = ?")
      .bind("sess-idempotent")
      .all<{ id: string }>();
    expect(allLeads.results).toHaveLength(1);

    // id and created_at preserved from first insert
    expect(secondCall.id).toBe(firstCall.id);
    expect(secondCall.created_at).toBe(firstCall.created_at);

    // Mutable fields updated by second call
    expect(secondCall.status).toBe("qualifying");
    expect(secondCall.fit_score).toBe(0.9);
    expect(secondCall.intent_score).toBe(0.8);
    expect(secondCall.summary).toBe("Good fit");
    expect(secondCall.source).toBe("widget");
    expect(secondCall.page_url).toBe("https://example.com");
    expect(secondCall.locale).toBe("en-US");
    expect(secondCall.qualification_json).toBe(JSON.stringify({ intent: "high" }));

    // updated_at must be >= created_at (the upsert always writes updated_at)
    expect(secondCall.updated_at >= secondCall.created_at).toBe(true);
  });
});

describe("SdrLeadsDB.upsertCustomerByEmail — real-SQL idempotency", () => {
  it("second call with same email returns ONE customers row with updated mutable fields", async () => {
    const first = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice",
      email: "alice@test.com",
      company: "Acme",
      role: "CTO",
    });

    const second = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice Lund",
      email: "alice@test.com",
      company: "Acme Inc",
      role: "VP Eng",
    });

    // Same id
    expect(second.id).toBe(first.id);

    // lifecycle stays 'lead' — not overwritten
    expect(second.lifecycle).toBe("lead");

    // Mutable fields updated
    expect(second.name).toBe("Alice Lund");
    expect(second.company).toBe("Acme Inc");
    expect(second.role).toBe("VP Eng");

    // Exactly one row in DB
    const count = await db
      .prepare("SELECT COUNT(*) as n FROM customers WHERE email = ?")
      .bind("alice@test.com")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("SdrLeadsDB.appendActivity + listActivitiesByLead — real-SQL ordering", () => {
  it("returns activities in occurred_at ascending order", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Bob",
      email: "bob@test.com",
      company: null,
      role: null,
    });
    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-activities",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    // Insert activities out of chronological order
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "qualification_updated",
      payload: { score: 0.7 },
      occurredAt: "2024-01-03T00:00:00.000Z",
    });
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "session_started",
      payload: null,
      occurredAt: "2024-01-01T00:00:00.000Z",
    });
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "note",
      payload: { text: "follow up" },
      occurredAt: "2024-01-02T00:00:00.000Z",
    });

    const activities = await SdrLeadsDB.listActivitiesByLead(db, lead.id);

    expect(activities).toHaveLength(3);
    expect(activities[0]?.type).toBe("session_started");
    expect(activities[1]?.type).toBe("note");
    expect(activities[2]?.type).toBe("qualification_updated");

    // Verify payload JSON is intact
    expect(activities[2]?.payload_json).toBe(JSON.stringify({ score: 0.7 }));
    expect(activities[0]?.payload_json).toBeNull();
  });
});

describe("SdrLeadsDB.getLeadBySession — real-SQL null + hit paths", () => {
  it("returns null when session does not exist", async () => {
    const result = await SdrLeadsDB.getLeadBySession(db, "sess-ghost");
    expect(result).toBeNull();
  });

  it("returns the lead row when session exists", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Carol",
      email: "carol@test.com",
      company: null,
      role: null,
    });
    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-carol",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    const result = await SdrLeadsDB.getLeadBySession(db, "sess-carol");
    expect(result).not.toBeNull();
    expect(result?.sdr_session_id).toBe("sess-carol");
    expect(result?.customer_id).toBe(customer.id);
  });
});

describe("SdrLeadsDB.getLeadById — real-SQL null + hit paths", () => {
  it("returns null when id does not exist", async () => {
    const result = await SdrLeadsDB.getLeadById(db, "lead-ghost");
    expect(result).toBeNull();
  });

  it("returns the lead row when id exists", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Dave",
      email: "dave@test.com",
      company: null,
      role: null,
    });
    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-dave",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    const result = await SdrLeadsDB.getLeadById(db, lead.id);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(lead.id);
  });
});

describe("SdrLeadsDB.listLeadsByProduct — real-SQL filtering", () => {
  it("returns leads filtered by product_id and optional status", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1" });
    await seedProduct(db, { id: "p2", slug: "product-2" });

    const c1 = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Eve",
      email: "eve@test.com",
      company: null,
      role: null,
    });
    const c2 = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Frank",
      email: "frank@test.com",
      company: null,
      role: null,
    });

    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: c1.id,
      productId: "p1",
      sdrSessionId: "sess-p1-new",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });
    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: c2.id,
      productId: "p1",
      sdrSessionId: "sess-p1-qualified",
      status: "qualified",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });
    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: c1.id,
      productId: "p2",
      sdrSessionId: "sess-p2-new",
      status: "new",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    // All for product p1
    const allP1 = await SdrLeadsDB.listLeadsByProduct(db, "p1");
    expect(allP1).toHaveLength(2);
    expect(allP1.every((l) => l.product_id === "p1")).toBe(true);

    // Filtered by status=new for p1
    const newP1 = await SdrLeadsDB.listLeadsByProduct(db, "p1", { status: "new" });
    expect(newP1).toHaveLength(1);
    expect(newP1[0]?.status).toBe("new");

    // p2 only
    const allP2 = await SdrLeadsDB.listLeadsByProduct(db, "p2");
    expect(allP2).toHaveLength(1);
    expect(allP2[0]?.sdr_session_id).toBe("sess-p2-new");

    // No leads for unknown product
    const empty = await SdrLeadsDB.listLeadsByProduct(db, "p-nonexistent");
    expect(empty).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Firewall — REAL SQL, not a mock
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.linkProductFirewallSafe — real-SQL firewall enforcement", () => {
  it("returns true and creates the row when no firewall conflict exists", async () => {
    await seedProduct(db, { id: "p-safe", slug: "safe-product", firewallGroup: null });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Grace",
      email: "grace@test.com",
      company: null,
      role: null,
    });

    const result = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p-safe");
    expect(result).toBe(true);

    const row = await db
      .prepare("SELECT 1 as found FROM customer_products WHERE customer_id = ? AND product_id = ?")
      .bind(customer.id, "p-safe")
      .first<{ found: number }>();
    expect(row?.found).toBe(1);
  });

  it("returns false and NO row is created when firewall blocks the link (real guard SQL)", async () => {
    // Seed two products in the same firewall_group — mirrors the CRE pair
    await seedProduct(db, { id: "p-cre-a", slug: "cre-a", name: "CRE-A", firewallGroup: "cre" });
    await seedProduct(db, { id: "p-cre-b", slug: "cre-b", name: "CRE-B", firewallGroup: "cre" });

    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Henry",
      email: "henry@test.com",
      company: null,
      role: null,
    });

    // Link to first CRE product — should succeed
    const firstLink = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p-cre-a");
    expect(firstLink).toBe(true);

    // Attempting to link to second CRE product must be blocked by the firewall guard
    const secondLink = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p-cre-b");
    expect(secondLink).toBe(false);

    // No customer_products row for p-cre-b
    const row = await db
      .prepare("SELECT 1 as found FROM customer_products WHERE customer_id = ? AND product_id = ?")
      .bind(customer.id, "p-cre-b")
      .first<{ found: number }>();
    expect(row).toBeNull();
  });

  it("returns false (no throw) when the customer is already linked to the same product", async () => {
    await seedProduct(db, { id: "p1", slug: "product-1", firewallGroup: null });
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Ivy",
      email: "ivy@test.com",
      company: null,
      role: null,
    });

    const first = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p1");
    expect(first).toBe(true);

    // Second link to same product — idempotent, not a firewall block
    const second = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p1");
    expect(second).toBe(false);

    // Still exactly one row
    const count = await db
      .prepare("SELECT COUNT(*) as n FROM customer_products WHERE customer_id = ? AND product_id = ?")
      .bind(customer.id, "p1")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("allows linking to a product whose firewall_group differs from an existing link", async () => {
    // p-cre in group "cre", p-saas with no group — no conflict
    await seedProduct(db, { id: "p-cre", slug: "p-cre", firewallGroup: "cre" });
    await seedProduct(db, { id: "p-saas", slug: "p-saas", firewallGroup: null });

    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Jack",
      email: "jack@test.com",
      company: null,
      role: null,
    });

    const firstLink = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p-cre");
    expect(firstLink).toBe(true);

    const secondLink = await SdrLeadsDB.linkProductFirewallSafe(db, customer.id, "p-saas");
    expect(secondLink).toBe(true);

    // Both rows exist
    const count = await db
      .prepare("SELECT COUNT(*) as n FROM customer_products WHERE customer_id = ?")
      .bind(customer.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
