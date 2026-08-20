/**
 * Fix 1 — Idempotent activity append on re-ingest.
 *
 * Uses the real-D1 harness (node:sqlite + all migrations) to assert that
 * ingesting the same session twice does NOT produce duplicate activity rows,
 * while a genuinely new activity type on a second ingest still lands.
 *
 * Strategy chosen: option (b) — dedupe by natural key (lead_id, type,
 * occurred_at) via UNIQUE constraint + ON CONFLICT DO NOTHING in appendActivity.
 * This keeps the existing "first ingest writes activities" behaviour and lets
 * later ingests with genuinely new (type, occurred_at) pairs still append,
 * while repeated identical activities are silently skipped.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";
import { SdrLeadsDB } from "../../src/db/sdr-leads";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProduct(db: D1Database, id = "p1", slug = "product-1"): Promise<void> {
  await db
    .prepare(
      `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, slug, slug, `wk_${id}`, "[]", null)
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
// Fix 1 tests
// ---------------------------------------------------------------------------

describe("appendActivity — idempotency on re-ingest (Fix 1)", () => {
  it("ingesting the same session twice does NOT produce duplicate activity rows", async () => {
    await seedProduct(db);
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice",
      email: "alice@fix1.com",
      company: null,
      role: null,
    });
    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-fix1-dup",
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

    const occurredAt = "2025-01-01T10:00:00.000Z";

    // First ingest — append two activities
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "session_started",
      payload: null,
      occurredAt,
    });
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "qualification_updated",
      payload: { step: 1 },
      occurredAt,
    });

    // Second ingest — same activities, same occurredAt (re-push of the same request)
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "session_started",
      payload: null,
      occurredAt,
    });
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "qualification_updated",
      payload: { step: 1 },
      occurredAt,
    });

    // COUNT must be 2, not 4
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM sdr_lead_activities WHERE lead_id = ?")
      .bind(lead.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);

    // Lead and customer rows are still correct
    const storedLead = await SdrLeadsDB.getLeadById(db, lead.id);
    expect(storedLead).not.toBeNull();
    expect(storedLead?.sdr_session_id).toBe("sess-fix1-dup");
    const storedCustomer = await db
      .prepare("SELECT email FROM customers WHERE id = ?")
      .bind(customer.id)
      .first<{ email: string }>();
    expect(storedCustomer?.email).toBe("alice@fix1.com");
  });

  it("a genuinely new activity type on a later ingest DOES get appended", async () => {
    await seedProduct(db);
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Bob",
      email: "bob@fix1.com",
      company: null,
      role: null,
    });
    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-fix1-new-act",
      status: "qualifying",
      qualification: null,
      fitScore: null,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    const firstOccurredAt = "2025-01-01T10:00:00.000Z";
    const secondOccurredAt = "2025-01-01T11:00:00.000Z";

    // First ingest: session_started only
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "session_started",
      payload: null,
      occurredAt: firstOccurredAt,
    });

    // Re-ingest of the same: duplicate session_started — must be deduplicated
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "session_started",
      payload: null,
      occurredAt: firstOccurredAt,
    });

    // Later ingest: handoff_requested with a new occurredAt — genuinely new event
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "handoff_requested",
      payload: { reason: "qualified" },
      occurredAt: secondOccurredAt,
    });

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM sdr_lead_activities WHERE lead_id = ?")
      .bind(lead.id)
      .first<{ n: number }>();
    // session_started (deduplicated to 1) + handoff_requested (new) = 2 total
    expect(count?.n).toBe(2);

    const activities = await SdrLeadsDB.listActivitiesByLead(db, lead.id);
    expect(activities).toHaveLength(2);
    const types = activities.map((a) => a.type);
    expect(types).toContain("session_started");
    expect(types).toContain("handoff_requested");
  });

  it("same type at a different occurredAt is treated as a distinct activity", async () => {
    await seedProduct(db);
    const customer = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Carol",
      email: "carol@fix1.com",
      company: null,
      role: null,
    });
    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: customer.id,
      productId: "p1",
      sdrSessionId: "sess-fix1-diff-time",
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

    // Two note activities at different timestamps — both should land
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "note",
      payload: { text: "first note" },
      occurredAt: "2025-01-01T09:00:00.000Z",
    });
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "note",
      payload: { text: "second note" },
      occurredAt: "2025-01-01T10:00:00.000Z",
    });

    // Re-push the first note (same type + same occurredAt) — must be skipped
    await SdrLeadsDB.appendActivity(db, {
      leadId: lead.id,
      type: "note",
      payload: { text: "first note" },
      occurredAt: "2025-01-01T09:00:00.000Z",
    });

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM sdr_lead_activities WHERE lead_id = ?")
      .bind(lead.id)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
