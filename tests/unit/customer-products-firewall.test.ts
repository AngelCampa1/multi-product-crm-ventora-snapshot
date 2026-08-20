import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";
import { linkCustomerToProduct } from "../../src/db/queries";
import { FirewallViolation } from "../../src/lib/firewall";

function d1Result(changes: number): D1Result {
  return { success: true, meta: { changes } as D1Result["meta"], results: [] };
}

function makeDb(runChanges: number, existingLink: unknown = null): D1Database {
  let prepareCount = 0;
  return {
    prepare: vi.fn((_sql: string) => {
      const index = prepareCount++;
      return {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue(d1Result(runChanges)),
        first: vi.fn().mockResolvedValue(index === 1 ? existingLink : null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        raw: vi.fn().mockResolvedValue([]),
      } as unknown as D1PreparedStatement;
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

describe("linkCustomerToProduct firewall enforcement", () => {
  it("uses a single guarded insert so concurrent same-group links cannot both pass preflight", async () => {
    const db = makeDb(1);
    const firewallCheck = vi.fn();

    await linkCustomerToProduct(db, "customer-1", "camaudit-v2", firewallCheck);

    const insertSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(insertSql).toContain("INSERT INTO customer_products");
    expect(insertSql).toContain("joined_at, source");
    expect(insertSql).toContain("NOT EXISTS");
    expect(insertSql).toContain("JOIN products existing");
    expect(insertSql).toContain("existing.firewall_group = candidate.firewall_group");
    expect(insertSql).toContain("FROM feedback_items");
    expect(firewallCheck).not.toHaveBeenCalled();
  });

  it("throws the firewall violation when the guarded insert is blocked by an existing same-group association", async () => {
    const db = makeDb(0);
    const violation = new FirewallViolation({
      customerId: "customer-1",
      candidateProductId: "camaudit-v2",
      conflictingProductId: "retired-product-01",
      firewallGroup: "cre",
    });
    const firewallCheck = vi.fn().mockRejectedValue(violation);

    await expect(linkCustomerToProduct(db, "customer-1", "camaudit-v2", firewallCheck)).rejects.toBe(violation);
  });

  it("treats an already-linked product as an idempotent success", async () => {
    const db = makeDb(0, { "1": 1 });
    const firewallCheck = vi.fn();

    await expect(linkCustomerToProduct(db, "customer-1", "camaudit-v2", firewallCheck)).resolves.toBe(false);
    expect(firewallCheck).not.toHaveBeenCalled();
  });

  it("promotes an existing content-derived link when an admin links it manually", async () => {
    const db = makeDb(0, { "1": 1 });
    const firewallCheck = vi.fn();

    await expect(linkCustomerToProduct(db, "customer-1", "camaudit-v2", firewallCheck, "manual")).resolves.toBe(false);

    const preparedSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(preparedSql.some((sql) => sql.includes("UPDATE customer_products SET source = 'manual'"))).toBe(true);
    expect(firewallCheck).not.toHaveBeenCalled();
  });
});

describe("customer product listing", () => {
  it("derives customer products from explicit links and product-scoped content", () => {
    const source = readFileSync("src/db/queries.ts", "utf8");

    expect(source).toContain("export async function listProductsForCustomer");
    expect(source).toContain("SELECT product_id FROM customer_products WHERE customer_id = ?");
    expect(source).toContain("SELECT product_id FROM testimonials WHERE customer_id = ?");
    expect(source).toContain("SELECT product_id FROM reviews WHERE customer_id = ?");
    expect(source).toContain("SELECT product_id FROM feedback_items WHERE customer_id = ?");
  });

  it("cleans up only content-derived product links when no content remains", () => {
    const source = readFileSync("src/db/queries.ts", "utf8");

    expect(source).toContain("export async function cleanupContentCustomerProductLink");
    expect(source).toContain("AND source = 'content'");
    expect(source).toContain("SELECT 1 FROM testimonials WHERE customer_id = ? AND product_id = ?");
    expect(source).toContain("SELECT 1 FROM reviews WHERE customer_id = ? AND product_id = ?");
    expect(source).toContain("SELECT 1 FROM feedback_items WHERE customer_id = ? AND product_id = ?");
  });
});
