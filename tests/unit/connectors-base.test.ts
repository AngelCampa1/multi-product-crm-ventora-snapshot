import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dedupAndSave } from "../../src/connectors/base";
import type { ConnectorResult } from "../../src/connectors/base";

type ExistingRows = Record<string, unknown>;
type RunFailures = Record<string, Error>;

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function review(overrides: Partial<ConnectorResult> = {}): ConnectorResult {
  return {
    external_id: "review-1",
    source: "manual",
    author_name: "Jordan Lee",
    body: "Clear and useful product feedback.",
    rating: 5,
    source_url: "https://example.com/reviews/1",
    imported_at: "2026-05-19T12:00:00.000Z",
    ...overrides,
  };
}

function makeDb(existingRows: ExistingRows = {}, runFailures: RunFailures = {}) {
  const statements: BoundStatement[] = [];

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const stmt = {
        sql,
        bindings: [],
        bind: vi.fn(function bind(this: BoundStatement, ...values: unknown[]) {
          this.bindings = values;
          return this;
        }),
        first: vi.fn(async function first(this: BoundStatement) {
          const productId = String(this.bindings[0]);
          const source = String(this.bindings[1]);
          const externalId = String(this.bindings[2]);
          return existingRows[`${productId}:${source}:${externalId}`] ?? null;
        }),
        all: vi.fn(),
        raw: vi.fn(),
        run: vi.fn(async function run(this: BoundStatement) {
          const isInsert = this.sql.includes("INSERT OR IGNORE INTO reviews");
          const source = String(this.bindings[isInsert ? 3 : 7]);
          const externalId = String(this.bindings[isInsert ? 4 : 8]);
          const failure = runFailures[`${source}:${externalId}`];
          if (failure) throw failure;
          return { success: true, meta: { changes: 1 } };
        }),
      } as unknown as BoundStatement;

      statements.push(stmt);
      return stmt;
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;

  return { db, statements };
}

function upsertStatements(statements: BoundStatement[]) {
  return statements.filter((stmt) => stmt.sql.includes("INSERT OR IGNORE INTO reviews"));
}

describe("dedupAndSave", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts new reviews", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000001");
    const { db, statements } = makeDb();

    const result = await dedupAndSave(db, "product-1", [
      review({ external_id: "new-review", source: "manual" }),
    ]);

    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0, errors: [] });
    expect(upsertStatements(statements)).toHaveLength(1);
    expect(upsertStatements(statements)[0]?.bindings).toEqual([
      "00000000-0000-4000-8000-000000000001",
      null,
      "product-1",
      "manual",
      "new-review",
      5,
      "Clear and useful product feedback.",
      "Jordan Lee",
      "https://example.com/reviews/1",
      expect.any(String),
    ]);
  });

  it("skips unchanged existing reviews with the same source and external_id", async () => {
    const { db, statements } = makeDb({
      "product-1:g2:existing-review": {
        id: "stored-review",
        product_id: "product-1",
        source: "g2",
        external_id: "existing-review",
        rating: 5,
        body: "Clear and useful product feedback.",
        author_name: "Jordan Lee",
        source_url: "https://example.com/reviews/1",
      },
    });

    const result = await dedupAndSave(db, "product-1", [
      review({ external_id: "existing-review", source: "g2" }),
    ]);

    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1, errors: [] });
    expect(upsertStatements(statements)).toHaveLength(0);
  });

  it("inserts separately when another product returns the same source external id", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000012");
    const { db, statements } = makeDb({
      "product-1:g2:existing-review": {
        id: "stored-review",
        product_id: "product-1",
        source: "g2",
        external_id: "existing-review",
        rating: 5,
        body: "Clear and useful product feedback.",
        author_name: "Jordan Lee",
        source_url: "https://example.com/reviews/1",
      },
    });

    const result = await dedupAndSave(db, "product-2", [
      review({ external_id: "existing-review", source: "g2" }),
    ]);

    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0, errors: [] });
    expect(upsertStatements(statements)).toHaveLength(1);
    expect(upsertStatements(statements)[0]?.bindings[2]).toBe("product-2");
  });

  it("updates existing reviews when source payload changes", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000011");
    const { db, statements } = makeDb({
      "product-1:g2:existing-review": {
        id: "stored-review",
        source: "g2",
        external_id: "existing-review",
        rating: 4,
        body: "Old body",
        author_name: "Jordan Lee",
        source_url: "https://example.com/reviews/1",
      },
    });

    const result = await dedupAndSave(db, "product-1", [
      review({ external_id: "existing-review", source: "g2", rating: 5, body: "Updated body" }),
    ]);

    expect(result).toEqual({ inserted: 0, updated: 1, skipped: 0, errors: [] });
    expect(upsertStatements(statements)).toHaveLength(1);
  });

  it("continues saving later reviews and reports insert errors", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000003");
    const insertError = new Error("D1 insert failed");
    const { db } = makeDb({}, { "manual:failing-review": insertError });

    const result = await dedupAndSave(db, "product-1", [
      review({ external_id: "failing-review", source: "manual" }),
      review({ external_id: "later-review", source: "manual" }),
    ]);

    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      skipped: 0,
      errors: [
        {
          source: "manual",
          external_id: "failing-review",
          error: "D1 insert failed",
        },
      ],
    });
  });
});
