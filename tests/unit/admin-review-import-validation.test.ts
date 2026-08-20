import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import reviewsRouter from "../../src/routes/admin/reviews";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rssXml = `<?xml version="1.0"?>
<rss><channel><item><title>Real review</title><guid>review-1</guid><description>Real body</description></item></channel></rss>`;

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeReviewImportDb() {
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
        first: vi.fn(async function first(this: BoundStatement) {
          if (this.sql.includes("FROM products")) return { id: String(this.bindings[0]) };
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
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

function makeConnectorConfigDb(opts: { source?: string; configJson?: string } = {}) {
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
        first: vi.fn(async function first(this: BoundStatement) {
          if (this.sql.includes("FROM connector_configs")) {
            return {
              id: "cfg_1",
              product_id: "product_1",
              source: opts.source ?? "rss",
              config_json: opts.configJson ?? "{\"feed_url\":\"https://example.com/feed.xml\"}",
              enabled: 1,
              last_polled_at: null,
              last_status: null,
              last_error: null,
              last_inserted: null,
              created_at: "2026-01-01T00:00:00.000Z",
            };
          }
          if (this.sql.includes("FROM products")) return { id: String(this.bindings[0]) };
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
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

function makeReviewPatchDb() {
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
        first: vi.fn(async function first(this: BoundStatement) {
          if (this.sql.includes("FROM reviews")) {
            return {
              id: "review_1",
              customer_id: null,
              product_id: "product_1",
              source: "manual",
              external_id: "ext_1",
              rating: null,
              body: "Real review",
              author_name: null,
              source_url: null,
              imported_at: "2026-01-01T00:00:00.000Z",
            };
          }
          if (this.sql.includes("FROM customers")) return { id: String(this.bindings[0]) };
          if (this.sql.includes("FROM products")) return { firewall_group: null };
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
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

function makeReviewListDb() {
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
        first: vi.fn(async () => ({ n: 0 })),
        all: vi.fn(async () => ({ results: [] })),
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

describe("admin review import validation", () => {
  it("rejects invalid review list sources before querying D1", async () => {
    const { db, statements } = makeReviewListDb();

    const response = await reviewsRouter.request("/?product_id=product_1&source=bad", {}, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "source must be a valid review source" });
    expect(statements).toHaveLength(0);
  });

  it("clamps review list pagination before passing it to D1", async () => {
    const { db, statements } = makeReviewListDb();

    const response = await reviewsRouter.request("/?product_id=product_1&limit=9999&offset=-20", {}, { DB: db });

    expect(response.status).toBe(200);
    const listStatement = statements.find((stmt) => stmt.sql.includes("FROM reviews WHERE product_id = ? ORDER BY"));
    expect(listStatement?.bindings).toEqual(["product_1", 200, 0]);
  });

  it("returns 400 for valid non-object manual import JSON instead of throwing", async () => {
    const { db } = makeReviewImportDb();

    const response = await reviewsRouter.request("/import/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "review import body must be a JSON object" });
  });

  it("returns 400 for malformed manual import JSON instead of throwing", async () => {
    const { db } = makeReviewImportDb();

    const response = await reviewsRouter.request("/import/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid JSON body" });
  });

  it("rejects manual import ratings outside the 1-5 range before inserting reviews", async () => {
    const { db, statements } = makeReviewImportDb();

    const response = await reviewsRouter.request("/import/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "product_1",
        body: "Real customer review text.",
        rating: 6,
      }),
    }, { DB: db });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "rating must be between 1 and 5" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it("returns 400 for malformed CSV import JSON instead of throwing", async () => {
    const { db } = makeReviewImportDb();

    const response = await reviewsRouter.request("/import/csv", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid JSON body" });
  });

  it.each([
    "/import/rss",
    "/import/trustpilot",
    "/import/g2",
  ])("returns 400 for malformed %s JSON instead of throwing", async (path) => {
    const { db } = makeReviewImportDb();

    const response = await reviewsRouter.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid JSON body" });
  });

  it.each([
    {
      path: "/import/manual",
      body: { product_id: "product_1", body: {} },
      error: "product_id and body are required",
    },
    {
      path: "/import/csv",
      body: { product_id: "product_1", csv_text: {} },
      error: "product_id and csv_text are required",
    },
    {
      path: "/import/rss",
      body: { product_id: "product_1", feed_url: {} },
      error: "product_id and feed_url are required",
    },
    {
      path: "/import/trustpilot",
      body: { product_id: "product_1", business_unit_id: {} },
      error: "product_id and business_unit_id are required",
    },
    {
      path: "/import/g2",
      body: { product_id: "product_1", product_slug: {} },
      error: "product_id and product_slug are required",
    },
  ])("rejects non-string required import fields for $path", async ({ path, body, error }) => {
    const { db, statements } = makeReviewImportDb();

    const response = await reviewsRouter.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it("accepts feed-backed App Store and Product Hunt source attribution on RSS imports", async () => {
    const { db, statements } = makeReviewImportDb();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));

    for (const reviewSource of ["app_store", "product_hunt"]) {
      const response = await reviewsRouter.request("/import/rss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_id: "product_1",
          feed_url: "https://example.com/feed.xml",
          review_source: reviewSource,
        }),
      }, { DB: db });

      expect(response.status).not.toBe(400);
    }
    expect(statements.some((stmt) => stmt.sql.includes("SELECT * FROM products WHERE id = ?"))).toBe(true);
  });

  it("rejects unsupported RSS import review_source values", async () => {
    const { db, statements } = makeReviewImportDb();

    const response = await reviewsRouter.request("/import/rss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product_id: "product_1",
        feed_url: "https://example.com/feed.xml",
        review_source: "g2",
      }),
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "review_source must be one of: rss, app_store, product_hunt",
    });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it.each([
    {
      path: "/import/rss",
      body: { product_id: "product_1", feed_url: "not-a-url" },
      error: "feed_url must be an absolute http or https URL",
    },
    {
      path: "/import/trustpilot",
      body: { product_id: "product_1", business_unit_id: "../bad" },
      error: "business_unit_id must be a valid Trustpilot review path segment",
    },
    {
      path: "/import/g2",
      body: { product_id: "product_1", product_slug: "bad/slug" },
      error: "product_slug must contain only letters, numbers, and hyphens",
    },
  ])("rejects semantically invalid direct scraper import config for $path", async ({ path, body, error }) => {
    const { db, statements } = makeReviewImportDb();

    const response = await reviewsRouter.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it.each([
    {
      path: "/import/trustpilot",
      body: { product_id: "product_1", business_unit_id: "example.com", page: "abc" },
    },
    {
      path: "/import/g2",
      body: { product_id: "product_1", product_slug: "example-product", page: 0 },
    },
  ])("rejects invalid direct scraper import page for $path", async ({ path, body }) => {
    const { db, statements } = makeReviewImportDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewsRouter.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "page must be a positive integer" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it.each([
    {
      path: "/import/g2",
      body: { product_id: "product_1", product_slug: "example-product" },
      expectedFetchUrl: "https://www.g2.com/products/example-product/reviews?page=1",
      expectedSource: "g2",
      expectedBody: "G2 route integration review",
      html: `<script type="application/ld+json">${JSON.stringify({
        "@type": "Review",
        author: { name: "G2 Author" },
        reviewBody: "G2 route integration review",
        reviewRating: { ratingValue: 4 },
        url: "https://www.g2.com/products/example-product/reviews/review-1",
      })}</script>`,
    },
    {
      path: "/import/trustpilot",
      body: { product_id: "product_1", business_unit_id: "example.com" },
      expectedFetchUrl: "https://www.trustpilot.com/review/example.com?page=1",
      expectedSource: "trustpilot",
      expectedBody: "Trustpilot route integration review",
      html: `<script type="application/ld+json">${JSON.stringify({
        "@type": "Review",
        author: { name: "Trustpilot Author" },
        reviewBody: "Trustpilot route integration review",
        reviewRating: { ratingValue: 5 },
        url: "https://www.trustpilot.com/reviews/review-1",
      })}</script>`,
    },
  ])("imports $expectedSource reviews through route scraper and D1 upsert", async ({
    path,
    body,
    expectedFetchUrl,
    expectedSource,
    expectedBody,
    html,
  }) => {
    const { db, statements } = makeReviewImportDb();
    const fetchMock = vi.fn(async () => new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewsRouter.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { DB: db });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      inserted: 1,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(expectedFetchUrl, expect.objectContaining({
      headers: expect.objectContaining({
        Accept: expect.stringContaining("text/html"),
      }),
    }));
    expect(statements.some((stmt) => stmt.sql.includes("SELECT * FROM products WHERE id = ?"))).toBe(true);
    const insert = statements.find((stmt) => stmt.sql.includes("INSERT OR IGNORE INTO reviews"));
    expect(insert?.bindings).toEqual(expect.arrayContaining(["product_1", expectedSource, expectedBody]));
  });

  it.each([
    "/connector-configs",
    "/connector-configs/cfg_1",
  ])("returns 400 for valid non-object connector config JSON on %s", async (path) => {
    const { db } = makeConnectorConfigDb();

    const response = await reviewsRouter.request(path, {
      method: path === "/connector-configs" ? "POST" : "PATCH",
      headers: { "content-type": "application/json" },
      body: "null",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "connector config body must be a JSON object" });
  });

  it("rejects semantically invalid stored connector config before test-run fetch", async () => {
    const { db, statements } = makeConnectorConfigDb({
      source: "g2",
      configJson: "{\"product_slug\":\"example-product\",\"page\":\"abc\"}",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await reviewsRouter.request("/connector-configs/cfg_1/test-run", {
      method: "POST",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "page must be a positive integer" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO reviews"))).toBe(false);
  });

  it.each([
    { body: "{", error: "invalid JSON body" },
    { body: "null", error: "review body must be a JSON object" },
    { body: JSON.stringify({ customer_id: 123 }), error: "customer_id must be a string or null" },
    { body: JSON.stringify({ customer_id: "" }), error: "customer_id must be a string or null" },
  ])("validates review link PATCH bodies: $error", async ({ body, error }) => {
    const { db, statements } = makeReviewPatchDb();

    const response = await reviewsRouter.request("/review_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(statements.some((stmt) => stmt.sql.includes("UPDATE reviews SET customer_id"))).toBe(false);
  });
});
