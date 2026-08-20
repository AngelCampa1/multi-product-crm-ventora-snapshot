/**
 * Task 1.2 — SdrLeadsDB query module tests.
 *
 * Harness: vi.fn() mock D1 matching the exact pattern used across this repo
 * (see tests/unit/firewall.test.ts, customer-products-firewall.test.ts,
 * reviews-db-upsert.test.ts, connector-configs.test.ts).
 * There is no real SQLite / Miniflare harness in this project.
 */

import { describe, it, expect, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import {
  SdrLeadsDB,
  type SdrLead,
  type SdrLeadActivity,
} from "../../src/db/sdr-leads";
import { FirewallViolation } from "../../src/lib/firewall";

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

type RunResult = D1Result & { meta: { changes: number } };

function runOk(changes = 1): RunResult {
  return { success: true, meta: { changes } as RunResult["meta"], results: [] };
}

interface StatementSpec {
  firstResult?: unknown;
  allResults?: unknown[];
  runChanges?: number;
}

/**
 * Builds a mock D1Database where each successive prepare() call returns the
 * corresponding spec from the array. The last spec repeats for any extra calls.
 */
function makeDb(specs: StatementSpec[]): D1Database {
  let idx = 0;
  return {
    prepare: vi.fn((_sql: string) => {
      const spec = specs[Math.min(idx++, specs.length - 1)]!;
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(spec.firstResult ?? null),
        all: vi.fn().mockResolvedValue({ results: spec.allResults ?? [] }),
        run: vi.fn().mockResolvedValue(runOk(spec.runChanges ?? 1)),
        raw: vi.fn().mockResolvedValue([]),
      } as unknown as D1PreparedStatement;
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

// A minimal customer row as the DB would return it.
const mockCustomer = {
  id: "cust-1",
  name: "Alice Lund",
  email: "alice@example.com",
  photo_r2_key: null,
  company: "Acme",
  role: "CTO",
  twitter: null,
  linkedin: null,
  website: null,
  lifecycle: "lead" as const,
  notes: null,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

const mockLead: SdrLead = {
  id: "lead-1",
  customer_id: "cust-1",
  product_id: "prod-1",
  sdr_session_id: "sess-abc",
  status: "new",
  qualification_json: null,
  fit_score: null,
  intent_score: null,
  summary: null,
  source: null,
  utm_json: null,
  page_url: null,
  locale: null,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
};

const mockActivity: SdrLeadActivity = {
  id: "act-1",
  lead_id: "lead-1",
  type: "session_started",
  payload_json: null,
  occurred_at: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// upsertCustomerByEmail
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.upsertCustomerByEmail", () => {
  it("inserts a new customer with lifecycle='lead' and returns the row", async () => {
    // Spec sequence: getByEmail → null (no existing), create → (returns from .first after run)
    // The implementation composes CustomersDB.getByEmail then CustomersDB.create.
    // getByEmail uses .first(); create uses .run() + returns constructed row.
    const db = makeDb([
      { firstResult: null }, // getByEmail
      { runChanges: 1 },     // INSERT into customers
    ]);

    const result = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice Lund",
      email: "alice@example.com",
      company: "Acme",
      role: "CTO",
    });

    expect(result.email).toBe("alice@example.com");
    expect(result.lifecycle).toBe("lead");
    expect(result.name).toBe("Alice Lund");
  });

  it("updates mutable fields on an existing customer without creating a duplicate", async () => {
    const db = makeDb([
      { firstResult: mockCustomer }, // getByEmail → found
      { runChanges: 1 },              // UPDATE customers
      { firstResult: { ...mockCustomer, name: "Alice Updated" } }, // re-fetch after update
    ]);

    const result = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Alice Updated",
      email: "alice@example.com",
      company: "Acme Inc",
      role: "CTO",
    });

    // Should return the updated name, not insert a duplicate.
    expect(result.email).toBe("alice@example.com");
    expect(result.name).toBe("Alice Updated");
    // Only one customer row should exist — the update path must not INSERT.
    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes("INSERT INTO customers"));
    expect(insertCalls).toHaveLength(0);
  });

  it("throws when updated customer cannot be re-fetched", async () => {
    // Simulates the (extremely unlikely) case where a customer is deleted between
    // the update and the re-fetch.
    const db = makeDb([
      { firstResult: mockCustomer }, // getByEmail → found
      { runChanges: 1 },              // UPDATE
      { firstResult: null },          // re-fetch returns null (vanished)
    ]);

    await expect(
      SdrLeadsDB.upsertCustomerByEmail(db, {
        name: "Alice",
        email: "alice@example.com",
        company: null,
        role: null,
      }),
    ).rejects.toThrow(/vanished after update/);
  });

  it("normalises email to lowercase + trimmed before lookup", async () => {
    const db = makeDb([
      { firstResult: null },
      { runChanges: 1 },
    ]);

    const result = await SdrLeadsDB.upsertCustomerByEmail(db, {
      name: "Bob",
      email: "  BOB@EXAMPLE.COM  ",
      company: null,
      role: null,
    });

    // The email stored / returned should be normalised.
    expect(result.email).toBe("bob@example.com");

    // The SQL lookup should receive the normalised value.
    const firstCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(firstCall).toContain("customers WHERE email");
    const bindArgs = ((db.prepare as ReturnType<typeof vi.fn>).mock.results[0]?.value as D1PreparedStatement)
      .bind as ReturnType<typeof vi.fn>;
    expect(bindArgs.mock.calls[0]).toContain("bob@example.com");
  });
});

// ---------------------------------------------------------------------------
// linkProductFirewallSafe
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.linkProductFirewallSafe", () => {
  it("returns true when the firewall-guarded insert succeeds", async () => {
    // insertCustomerProductIfFirewallSafe uses a single INSERT ... WHERE NOT EXISTS
    // and returns changes > 0 when it inserts.
    const db = makeDb([
      { runChanges: 1 }, // INSERT INTO customer_products (guarded)
    ]);

    const result = await SdrLeadsDB.linkProductFirewallSafe(db, "cust-1", "prod-1");

    expect(result).toBe(true);
  });

  it("returns false (does NOT throw) when the firewall blocks the link", async () => {
    // Simulate: guarded insert writes 0 rows (firewall subquery blocked it),
    // existing-link check returns null (not already linked),
    // assertFirewallSafe throws FirewallViolation.
    // The method must catch FirewallViolation and return false.
    const violation = new FirewallViolation({
      customerId: "cust-1",
      candidateProductId: "prod-cre-b",
      conflictingProductId: "prod-cre-a",
      firewallGroup: "cre",
    });

    const firewallCheck = vi.fn().mockRejectedValue(violation);

    const db = makeDb([
      { runChanges: 0 }, // guarded INSERT blocked
      { firstResult: null }, // no existing link
    ]);

    const result = await SdrLeadsDB.linkProductFirewallSafe(db, "cust-1", "prod-cre-b", firewallCheck);

    expect(result).toBe(false);
    expect(firewallCheck).toHaveBeenCalledWith(db, "cust-1", "prod-cre-b");
  });

  it("re-throws non-FirewallViolation errors", async () => {
    const boom = new Error("unexpected DB failure");
    const firewallCheck = vi.fn().mockRejectedValue(boom);
    const db = makeDb([
      { runChanges: 0 }, // guarded INSERT blocked
      { firstResult: null }, // no existing link
    ]);

    await expect(SdrLeadsDB.linkProductFirewallSafe(db, "cust-1", "prod-1", firewallCheck)).rejects.toBe(boom);
  });

  it("returns false (no throw) when link already exists", async () => {
    const firewallCheck = vi.fn();
    const db = makeDb([
      { runChanges: 0 },          // guarded INSERT wrote 0
      { firstResult: { "1": 1 } }, // existing link found
    ]);

    const result = await SdrLeadsDB.linkProductFirewallSafe(db, "cust-1", "prod-1", firewallCheck);

    expect(result).toBe(false);
    // Firewall check should not have been called — link already exists.
    expect(firewallCheck).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// upsertLeadBySession
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.upsertLeadBySession", () => {
  it("inserts a new lead row and returns it with created_at set", async () => {
    const db = makeDb([
      { runChanges: 1 },        // ON CONFLICT upsert
      { firstResult: mockLead }, // SELECT after upsert
    ]);

    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: "cust-1",
      productId: "prod-1",
      sdrSessionId: "sess-abc",
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

    expect(lead.sdr_session_id).toBe("sess-abc");
    expect(lead.status).toBe("new");
    expect(lead.id).toBe("lead-1");
  });

  it("second call with the same sdr_session_id updates rather than inserts a duplicate", async () => {
    const updatedLead: SdrLead = { ...mockLead, status: "qualifying", fit_score: 0.8 };
    const db = makeDb([
      { runChanges: 1 },              // ON CONFLICT upsert (updates existing)
      { firstResult: updatedLead },   // SELECT after upsert
    ]);

    const lead = await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: "cust-1",
      productId: "prod-1",
      sdrSessionId: "sess-abc",
      status: "qualifying",
      qualification: null,
      fitScore: 0.8,
      intentScore: null,
      summary: null,
      source: null,
      utm: null,
      pageUrl: null,
      locale: null,
    });

    // ON CONFLICT means only one upsert statement — no separate INSERT.
    const insertCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => String(call[0]).includes("INSERT INTO sdr_leads"),
    );
    expect(insertCalls).toHaveLength(1); // exactly one statement (INSERT … ON CONFLICT)
    expect(lead.status).toBe("qualifying");
    expect(lead.fit_score).toBe(0.8);
  });

  it("stringifies qualification and utm objects when provided", async () => {
    const db = makeDb([
      { runChanges: 1 },
      { firstResult: mockLead },
    ]);

    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: "cust-1",
      productId: "prod-1",
      sdrSessionId: "sess-abc",
      status: "qualified",
      qualification: { intent: "high" },
      fitScore: 0.9,
      intentScore: 0.8,
      summary: "Good fit",
      source: "website",
      utm: { campaign: "q1" },
      pageUrl: "https://example.com/pricing",
      locale: "en-US",
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0]?.value as D1PreparedStatement;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // qualification_json and utm_json should be JSON strings
    expect(bindArgs).toContain(JSON.stringify({ intent: "high" }));
    expect(bindArgs).toContain(JSON.stringify({ campaign: "q1" }));
  });

  it("always updates updated_at on conflict", async () => {
    const db = makeDb([
      { runChanges: 1 },
      { firstResult: mockLead },
    ]);

    await SdrLeadsDB.upsertLeadBySession(db, {
      customerId: "cust-1",
      productId: "prod-1",
      sdrSessionId: "sess-abc",
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

    const upsertSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(upsertSql).toContain("ON CONFLICT");
    expect(upsertSql).toContain("updated_at");
  });
});

// ---------------------------------------------------------------------------
// appendActivity + listActivitiesByLead
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.appendActivity", () => {
  it("inserts one activity row for the given lead", async () => {
    const db = makeDb([{ runChanges: 1 }]);

    await SdrLeadsDB.appendActivity(db, {
      leadId: "lead-1",
      type: "session_started",
      payload: null,
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).toContain("INSERT INTO sdr_lead_activities");
  });

  it("stringifies a payload object into payload_json", async () => {
    const db = makeDb([{ runChanges: 1 }]);
    const payload = { score: 0.9, reason: "high intent" };

    await SdrLeadsDB.appendActivity(db, {
      leadId: "lead-1",
      type: "qualification_updated",
      payload,
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0]?.value as D1PreparedStatement;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    // payload_json should be a JSON string, not the object itself
    const payloadArg = bindArgs.find((a) => typeof a === "string" && a.startsWith("{"));
    expect(payloadArg).toBe(JSON.stringify(payload));
  });
});

describe("SdrLeadsDB.listActivitiesByLead", () => {
  it("returns activities ordered by occurred_at ascending", async () => {
    const activities: SdrLeadActivity[] = [
      { ...mockActivity, id: "act-1", occurred_at: "2024-01-01T00:00:00.000Z" },
      { ...mockActivity, id: "act-2", type: "qualification_updated", occurred_at: "2024-01-02T00:00:00.000Z" },
    ];
    const db = makeDb([{ allResults: activities }]);

    const result = await SdrLeadsDB.listActivitiesByLead(db, "lead-1");

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("act-1");
    expect(result[1]?.id).toBe("act-2");

    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).toContain("ORDER BY occurred_at");
    expect(sql).toContain("lead_id = ?");
  });

  it("returns empty array when no activities exist for lead", async () => {
    const db = makeDb([{ allResults: [] }]);
    const result = await SdrLeadsDB.listActivitiesByLead(db, "lead-no-activities");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLeadBySession + getLeadById
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.getLeadBySession", () => {
  it("returns the lead row when session exists", async () => {
    const db = makeDb([{ firstResult: mockLead }]);
    const result = await SdrLeadsDB.getLeadBySession(db, "sess-abc");
    expect(result).toEqual(mockLead);
  });

  it("returns null when session does not exist", async () => {
    const db = makeDb([{ firstResult: null }]);
    const result = await SdrLeadsDB.getLeadBySession(db, "sess-ghost");
    expect(result).toBeNull();
  });
});

describe("SdrLeadsDB.getLeadById", () => {
  it("returns the lead row when id exists", async () => {
    const db = makeDb([{ firstResult: mockLead }]);
    const result = await SdrLeadsDB.getLeadById(db, "lead-1");
    expect(result).toEqual(mockLead);
  });

  it("returns null when id does not exist", async () => {
    const db = makeDb([{ firstResult: null }]);
    const result = await SdrLeadsDB.getLeadById(db, "lead-ghost");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listLeadsByProduct
// ---------------------------------------------------------------------------

describe("SdrLeadsDB.listLeadsByProduct", () => {
  it("returns all leads for a product with default limit 50", async () => {
    const leads = [mockLead, { ...mockLead, id: "lead-2", sdr_session_id: "sess-2" }];
    const db = makeDb([{ allResults: leads }]);

    const result = await SdrLeadsDB.listLeadsByProduct(db, "prod-1");

    expect(result).toHaveLength(2);
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).toContain("product_id = ?");
    expect(sql).toContain("LIMIT");
  });

  it("filters by status when provided", async () => {
    const db = makeDb([{ allResults: [mockLead] }]);

    await SdrLeadsDB.listLeadsByProduct(db, "prod-1", { status: "qualified" });

    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(sql).toContain("status = ?");

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0]?.value as D1PreparedStatement;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(bindArgs).toContain("qualified");
  });

  it("applies custom limit", async () => {
    const db = makeDb([{ allResults: [] }]);
    await SdrLeadsDB.listLeadsByProduct(db, "prod-1", { limit: 10 });

    const stmt = (db.prepare as ReturnType<typeof vi.fn>).mock.results[0]?.value as D1PreparedStatement;
    const bindArgs = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(bindArgs).toContain(10);
  });

  it("returns empty array when no leads match", async () => {
    const db = makeDb([{ allResults: [] }]);
    const result = await SdrLeadsDB.listLeadsByProduct(db, "prod-no-leads");
    expect(result).toEqual([]);
  });
});
