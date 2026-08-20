/**
 * Self-test for the real-D1 harness.
 *
 * Proves that the node:sqlite-backed adapter actually enforces CHECK, UNIQUE,
 * and FK constraints — so tests that depend on the harness are trustworthy.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createRealD1 } from "../helpers/real-d1";

let db: D1Database;

beforeEach(() => {
  db = createRealD1();
});

// ---------------------------------------------------------------------------
// Harness bootstraps the full schema
// ---------------------------------------------------------------------------

describe("real-d1 harness — schema bootstrap", () => {
  it("creates sdr_leads table (all migrations applied)", async () => {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sdr_leads'")
      .first<{ name: string }>();
    expect(row?.name).toBe("sdr_leads");
  });

  it("creates sdr_lead_activities table", async () => {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sdr_lead_activities'")
      .first<{ name: string }>();
    expect(row?.name).toBe("sdr_lead_activities");
  });

  it("creates products table (migration 0001)", async () => {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
      .first<{ name: string }>();
    expect(row?.name).toBe("products");
  });
});

// ---------------------------------------------------------------------------
// CHECK constraint enforcement
// ---------------------------------------------------------------------------

describe("real-d1 harness — CHECK enforcement (sdr_leads.status)", () => {
  it("rejects an invalid status value", async () => {
    // Insert prerequisite product + customer
    await db
      .prepare(
        "INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("p1", "p1-slug", "Product 1", "wk_test_p1", "[]")
      .run();
    await db
      .prepare(
        "INSERT INTO customers (id, name, email, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("c1", "Test User", "test@example.com", "lead", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("l1", "c1", "p1", "sess-1", "bogus", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });

  it("accepts all valid status values", async () => {
    await db
      .prepare(
        "INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("p1", "p1-slug", "Product 1", "wk_test_p1", "[]")
      .run();
    await db
      .prepare(
        "INSERT INTO customers (id, name, email, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("c1", "Test User", "test@example.com", "lead", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();

    const validStatuses = ["new", "qualifying", "qualified", "handoff_requested", "accepted", "disqualified"];
    for (const [i, status] of validStatuses.entries()) {
      await expect(
        db
          .prepare(
            `INSERT INTO sdr_leads
             (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(`l${i}`, "c1", "p1", `sess-${i}`, status, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
          .run(),
      ).resolves.toMatchObject({ success: true });
    }
  });
});

describe("real-d1 harness — CHECK enforcement (sdr_lead_activities.type)", () => {
  it("rejects an invalid activity type", async () => {
    await db
      .prepare(
        "INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("p1", "p1-slug", "Product 1", "wk_test_p1", "[]")
      .run();
    await db
      .prepare(
        "INSERT INTO customers (id, name, email, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("c1", "Test User", "test@example.com", "lead", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();
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
        .prepare(
          "INSERT INTO sdr_lead_activities (id, lead_id, type, occurred_at) VALUES (?, ?, ?, ?)",
        )
        .bind("a1", "l1", "bogus_type", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UNIQUE constraint enforcement
// ---------------------------------------------------------------------------

describe("real-d1 harness — UNIQUE enforcement (sdr_session_id)", () => {
  it("rejects a duplicate sdr_session_id", async () => {
    await db
      .prepare(
        "INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("p1", "p1-slug", "Product 1", "wk_test_p1", "[]")
      .run();
    await db
      .prepare(
        "INSERT INTO customers (id, name, email, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("c1", "Test User", "test@example.com", "lead", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();
    await db
      .prepare(
        `INSERT INTO sdr_leads
         (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("l1", "c1", "p1", "sess-dup", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("l2", "c1", "p1", "sess-dup", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FK constraint enforcement
// ---------------------------------------------------------------------------

describe("real-d1 harness — FK enforcement", () => {
  it("rejects an sdr_lead referencing a non-existent customer_id (FK enforced)", async () => {
    await db
      .prepare(
        "INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("p1", "p1-slug", "Product 1", "wk_test_p1", "[]")
      .run();

    await expect(
      db
        .prepare(
          `INSERT INTO sdr_leads
           (id, customer_id, product_id, sdr_session_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind("l1", "nonexistent-customer", "p1", "sess-1", "new", "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z")
        .run(),
    ).rejects.toThrow();
  });
});
