import { describe, it, expect, vi } from "vitest";
import { assertFirewallSafe, FirewallViolation } from "../../src/lib/firewall";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

// ---------------------------------------------------------------------------
// D1 mock factory
//
// D1Database.prepare() returns a D1PreparedStatement; we only need .bind(),
// .first(), and .all(). Each call to makeDb() receives a map that controls
// what .first() and .all() return, keyed by which SQL verb is in the query
// (crude but sufficient — firewall.ts only issues two distinct queries).
// ---------------------------------------------------------------------------

type FirstFn = () => Promise<unknown>;
type AllFn = () => Promise<{ results: unknown[] }>;

interface QuerySpec {
  first: FirstFn;
  all: AllFn;
}

// Tracks call sequence so we can return different values per invocation.
function makeDb(specs: QuerySpec[]): D1Database {
  let callIndex = 0;

  const makeStatement = (spec: QuerySpec): D1PreparedStatement => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockImplementation(spec.first),
      all: vi.fn().mockImplementation(spec.all),
      run: vi.fn().mockResolvedValue({ success: true }),
      raw: vi.fn().mockResolvedValue([]),
    } as unknown as D1PreparedStatement;
    return stmt;
  };

  const db = {
    prepare: vi.fn().mockImplementation(() => {
      const spec = specs[callIndex] ?? specs[specs.length - 1] ?? specs[0];
      callIndex++;
      return makeStatement(spec!);
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return db;
}

function neverAll(): Promise<D1Result<unknown>> {
  return Promise.resolve({ results: [], success: true, meta: {} as D1Result["meta"] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assertFirewallSafe", () => {
  it("passes silently when candidate product has null firewall_group", async () => {
    const db = makeDb([
      {
        first: async () => ({ firewall_group: null }),
        all: neverAll,
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "prod-no-group")).resolves.toBeUndefined();
  });

  it("passes when candidate has a firewall_group but customer has NO other product links", async () => {
    const db = makeDb([
      {
        // candidateRow — product IS in "cre" group
        first: async () => ({ firewall_group: "cre" }),
        all: neverAll,
      },
      {
        // conflicts query — no results
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} as D1Result["meta"] }),
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "prod-cre-a")).resolves.toBeUndefined();
  });

  it("throws FirewallViolation when customer is already linked to a product in the same firewall_group", async () => {
    const db = makeDb([
      {
        // candidateRow — product IS in "cre"
        first: async () => ({ firewall_group: "cre" }),
        all: neverAll,
      },
      {
        // conflicts — returns an existing linked product in "cre"
        first: async () => null,
        all: async () => ({
          results: [{ product_id: "prod-cre-existing", firewall_group: "cre" }],
          success: true,
          meta: {} as D1Result["meta"],
        }),
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "prod-cre-new")).rejects.toThrow(FirewallViolation);
  });

  it("checks testimonial review and feedback associations, not only customer_products", async () => {
    const db = makeDb([
      {
        first: async () => ({ firewall_group: "cre" }),
        all: neverAll,
      },
      {
        first: async () => null,
        all: async () => ({
          results: [{ product_id: "review-only-product", firewall_group: "cre" }],
          success: true,
          meta: {} as D1Result["meta"],
        }),
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "candidate-product")).rejects.toThrow(FirewallViolation);
    const conflictQuery = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as string;
    expect(conflictQuery).toContain("FROM testimonials");
    expect(conflictQuery).toContain("FROM reviews");
    expect(conflictQuery).toContain("FROM feedback_items");
  });

  it("passes when customer has a 'cre'-group link but the candidate product is in a DIFFERENT group", async () => {
    // candidateRow has firewall_group = "other", so the conflicts query filters
    // on "other" — which returns nothing.
    const db = makeDb([
      {
        first: async () => ({ firewall_group: "other" }),
        all: neverAll,
      },
      {
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} as D1Result["meta"] }),
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "prod-other-group")).resolves.toBeUndefined();
  });

  it("passes when candidate product group is null even if customer has existing cre links", async () => {
    // If firewall_group is null we return early before querying conflicts at all.
    const db = makeDb([
      {
        first: async () => ({ firewall_group: null }),
        all: neverAll,
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "prod-null-group")).resolves.toBeUndefined();
    // Only one prepare() call should have been made (the candidateRow lookup).
    expect((db.prepare as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("FirewallViolation carries correct customerId, candidateProductId, conflictingProductId, firewallGroup", async () => {
    const db = makeDb([
      {
        first: async () => ({ name: "CAMAudit", firewall_group: "cre" }),
        all: neverAll,
      },
      {
        first: async () => null,
        all: async () => ({
          results: [
            { product_id: "retired-product-01-prod-id", product_name: "RetiredProduct01", firewall_group: "cre" },
          ],
          success: true,
          meta: {} as D1Result["meta"],
        }),
      },
    ]);

    let caught: FirewallViolation | null = null;
    try {
      await assertFirewallSafe(db, "tenant-cust", "camaudit-prod-id");
    } catch (err) {
      caught = err as FirewallViolation;
    }

    expect(caught).toBeInstanceOf(FirewallViolation);
    expect(caught!.customerId).toBe("tenant-cust");
    expect(caught!.candidateProductId).toBe("camaudit-prod-id");
    expect(caught!.conflictingProductId).toBe("retired-product-01-prod-id");
    expect(caught!.firewallGroup).toBe("cre");
    expect(caught!.code).toBe("FIREWALL_VIOLATION");
    // Friendly, customer-facing message uses product names — no UUIDs, slugs, or group names.
    expect(caught!.candidateProductName).toBe("CAMAudit");
    expect(caught!.conflictingProductName).toBe("RetiredProduct01");
    expect(caught!.userMessage).toContain("CAMAudit");
    expect(caught!.userMessage).toContain("RetiredProduct01");
    expect(caught!.userMessage).not.toMatch(/cre|tenant-cust|prod-id/);
  });

  it("throws Error('unknown product ...') when candidateProductId not found in DB", async () => {
    const db = makeDb([
      {
        first: async () => null, // product lookup returns nothing
        all: neverAll,
      },
    ]);

    await expect(assertFirewallSafe(db, "cust-1", "ghost-product-id")).rejects.toThrow(
      /unknown product ghost-product-id/,
    );
  });
});
