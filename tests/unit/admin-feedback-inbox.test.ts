import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import feedbackRouter from "../../src/routes/admin/feedback";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeFeedbackListDb() {
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
        all: vi.fn(async () => ({
          results: [
            {
              id: "fb_1",
              customer_id: null,
              product_id: "product_1",
              type: "feature_request",
              title: "Global inbox item",
              body: null,
              status: "new",
              upvotes: 0,
              public_visible: 0,
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              product_slug: "grantpipe",
              product_name: "GrantPipe",
            },
          ],
        })),
        first: vi.fn(async () => ({ n: 1 })),
        raw: vi.fn(),
        run: vi.fn(),
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

function makeDbThatMustNotBeUsed(): D1Database {
  return {
    prepare: vi.fn(() => {
      throw new Error("DB should not be used for invalid payload");
    }),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function makeFeedbackPatchDb() {
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
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => ({
          id: "fb_1",
          customer_id: null,
          product_id: "product_1",
          type: "bug",
          title: "Existing",
          body: null,
          status: "new",
          upvotes: 0,
          public_visible: 0,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        })),
        raw: vi.fn(),
        run: vi.fn(async () => ({ success: true })),
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

describe("admin feedback inbox", () => {
  it("lists feedback across all products when product_id is omitted", async () => {
    const { db, statements } = makeFeedbackListDb();

    const response = await feedbackRouter.request("/?status=new", {}, { DB: db });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "fb_1",
          product_slug: "grantpipe",
          product_name: "GrantPipe",
        }),
      ],
      total: 1,
    });
    expect(statements[0]?.sql).toContain("LEFT JOIN products p ON p.id = f.product_id");
    expect(statements[0]?.sql).not.toContain("f.product_id = ?");
  });

  it("clamps invalid global inbox pagination before querying", async () => {
    const { db, statements } = makeFeedbackListDb();

    const response = await feedbackRouter.request("/?limit=5000&offset=-20", {}, { DB: db });

    expect(response.status).toBe(200);
    expect(statements[0]?.bindings.at(-2)).toBe(200);
    expect(statements[0]?.bindings.at(-1)).toBe(0);
  });

  it("preserves product type and status filters on feedback listings", async () => {
    const { db, statements } = makeFeedbackListDb();

    const response = await feedbackRouter.request(
      "/?product_id=product_1&type=feature_request&status=planned&limit=25&offset=5",
      {},
      { DB: db },
    );

    expect(response.status).toBe(200);
    expect(statements[0]?.sql).toContain("f.product_id = ?");
    expect(statements[0]?.sql).toContain("f.type = ?");
    expect(statements[0]?.sql).toContain("f.status = ?");
    expect(statements[0]?.bindings).toEqual(["product_1", "feature_request", "planned", 25, 5]);
    expect(statements[1]?.bindings).toEqual(["product_1", "feature_request", "planned"]);
  });

  it.each([
    { method: "POST", path: "/", body: "null" },
    { method: "PATCH", path: "/fb_1", body: "null" },
    { method: "PATCH", path: "/fb_1/status", body: "null" },
  ])("returns 400 for valid non-object feedback mutation JSON on $method $path", async ({ method, path, body }) => {
    const { db } = makeFeedbackListDb();

    const response = await feedbackRouter.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body,
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "feedback body must be a JSON object" });
  });

  it("rejects non-string feedback titles on create before product lookup", async () => {
    const response = await feedbackRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "product_1",
        type: "bug",
        title: 123,
      }),
    }, { DB: makeDbThatMustNotBeUsed() });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "title must not be empty" });
  });

  it("rejects non-string feedback titles on patch before updating", async () => {
    const { db, statements } = makeFeedbackPatchDb();

    const response = await feedbackRouter.request("/fb_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: 123 }),
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "title must not be empty" });
    expect(statements.some((stmt) => stmt.sql.includes("UPDATE feedback_items SET"))).toBe(false);
  });
});
