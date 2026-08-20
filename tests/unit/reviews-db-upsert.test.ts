import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { ReviewsDB } from "../../src/db/queries";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

describe("ReviewsDB.upsert", () => {
  it("refreshes customer and import metadata on product-scoped source external id conflicts", async () => {
    const statements: BoundStatement[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const stmt = {
          sql,
          bindings: [],
          bind: vi.fn(function bind(this: BoundStatement, ...values: unknown[]) {
            this.bindings = values;
            return this;
          }),
          run: vi.fn(async () => ({ success: true })),
        } as unknown as BoundStatement;
        statements.push(stmt);
        return stmt;
      }),
      batch: vi.fn(),
      dump: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    await ReviewsDB.upsert(db, {
      customer_id: "customer-2",
      product_id: "product-2",
      source: "g2",
      external_id: "review-1",
      rating: 5,
      body: "Updated review body",
      author_name: "Jane",
      source_url: "https://example.com/reviews/1",
    });

    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO reviews");
    expect(statements[0]?.sql).not.toContain("ON CONFLICT(product_id, source, external_id)");
    expect(statements[1]?.sql).toContain("UPDATE reviews");
    expect(statements[1]?.sql).toContain("WHERE product_id = ? AND source = ? AND external_id = ?");
  });
});
