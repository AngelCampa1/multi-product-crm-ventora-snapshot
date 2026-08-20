import { readFileSync } from "fs";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import reviewsRouter from "../../src/routes/admin/reviews";
import { ConnectorConfigsDB } from "../../src/db/queries";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeDb(rows: Record<string, unknown> = {}) {
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
          if (this.sql.includes("FROM products")) {
            return rows[`product:${String(this.bindings[0])}`] ?? null;
          }
          if (this.sql.includes("FROM connector_configs")) {
            return rows[`config:${String(this.bindings[0])}`] ?? null;
          }
          return null;
        }),
        all: vi.fn(async () => ({
          results: Object.values(rows).filter(
            (row) => typeof row === "object" && row !== null && "config_json" in row,
          ),
        })),
        raw: vi.fn(),
        run: vi.fn(async function run(this: BoundStatement) {
          if (this.sql.includes("INSERT INTO connector_configs")) {
            const [id, productId, source, configJson, enabled] = this.bindings as [
              string,
              string,
              string,
              string,
              number,
            ];
            const existing = rows[`config:${id}`] as Record<string, unknown> | undefined;
            const targetChanged = existing !== undefined && (
              existing.product_id !== productId ||
              existing.source !== source ||
              existing.config_json !== configJson
            );
            rows[`config:${id}`] = {
              id,
              product_id: productId,
              source,
              config_json: configJson,
              enabled,
              last_polled_at: targetChanged ? null : existing?.last_polled_at ?? null,
              last_status: targetChanged ? null : existing?.last_status ?? null,
              last_error: targetChanged ? null : existing?.last_error ?? null,
              last_inserted: targetChanged ? null : existing?.last_inserted ?? null,
              created_at: existing?.created_at ?? "2026-05-19T00:00:00.000Z",
            };
          }
          return { success: true };
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

describe("ConnectorConfigsDB", () => {
  it("lists connector configs for a product with parsed config", async () => {
    const { db } = makeDb({
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    await expect(ConnectorConfigsDB.listByProduct(db, "product_1")).resolves.toEqual([
      expect.objectContaining({
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config: { feed_url: "https://example.com/feed.xml" },
        enabled: true,
      }),
    ]);
  });

  it("upserts connector configs as JSON-backed rows", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("00000000-0000-4000-8000-000000000010");
    const { db, statements } = makeDb();

    const config = await ConnectorConfigsDB.upsert(db, {
      product_id: "product_1",
      source: "trustpilot",
      config: { business_unit_id: "ventora" },
      enabled: false,
    });

    expect(config).toEqual(expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000010",
      enabled: false,
      config: { business_unit_id: "ventora" },
    }));
    expect(statements.find((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))?.bindings)
      .toContain("{\"business_unit_id\":\"ventora\"}");
  });
});

describe("admin review connector config routes", () => {
  it("lists connector configs for admins", async () => {
    const { db } = makeDb({
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "g2",
        config_json: "{\"product_slug\":\"ventora\"}",
        enabled: 1,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs?product_id=product_1", {}, { DB: db });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configs: [
        expect.objectContaining({
          id: "cfg_1",
          config: { product_slug: "ventora" },
        }),
      ],
    });
  });

  it("creates connector configs only for existing products", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "rss",
        config: { feed_url: "https://example.com/feed.xml" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      product_id: "product_1",
      source: "rss",
      enabled: true,
    }));
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(true);
  });

  it("rejects non-boolean enabled values when creating connector configs", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "rss",
        config: { feed_url: "https://example.com/feed.xml" },
        enabled: "false",
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "enabled must be a boolean" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("allows RSS connector configs to preserve feed-backed review source attribution", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "rss",
        config: {
          feed_url: "https://example.com/product-hunt.xml",
          review_source: "product_hunt",
        },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(201);
    const insertBindings = statements.find((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))?.bindings;
    expect(insertBindings).toContain("{\"feed_url\":\"https://example.com/product-hunt.xml\",\"review_source\":\"product_hunt\"}");
  });

  it("rejects invalid RSS connector review_source values", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "rss",
        config: {
          feed_url: "https://example.com/feed.xml",
          review_source: "g2",
        },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "review_source must be one of: rss, app_store, product_hunt" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("rejects connector configs without the required source config", async () => {
    const { db } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "g2",
        config: { product_slug: "" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "product_slug is required" });
  });

  it.each([
    {
      source: "rss",
      config: { feed_url: "not-a-url" },
      error: "feed_url must be an absolute http or https URL",
    },
    {
      source: "g2",
      config: { product_slug: "bad/slug" },
      error: "product_slug must contain only letters, numbers, and hyphens",
    },
    {
      source: "trustpilot",
      config: { business_unit_id: "../bad" },
      error: "business_unit_id must be a valid Trustpilot review path segment",
    },
  ])("rejects semantically invalid $source connector config", async ({ source, config, error }) => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source,
        config,
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("rejects semantically invalid connector config updates", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://old.example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_1", {
      method: "PATCH",
      body: JSON.stringify({
        config: { feed_url: "ftp://example.com/feed.xml" },
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "feed_url must be an absolute http or https URL" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("rejects non-boolean enabled values when updating connector configs", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://old.example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_1", {
      method: "PATCH",
      body: JSON.stringify({ enabled: "false" }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "enabled must be a boolean" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("updates existing connector configs", async () => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://old.example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: "2026-05-19T01:00:00.000Z",
        last_status: "ok",
        last_error: null,
        last_inserted: 3,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_1", {
      method: "PATCH",
      body: JSON.stringify({
        config: { feed_url: "https://new.example.com/feed.xml" },
        enabled: false,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      id: "cfg_1",
      enabled: false,
      config: { feed_url: "https://new.example.com/feed.xml" },
      last_polled_at: null,
      last_status: null,
      last_inserted: null,
      created_at: "2026-05-19T00:00:00.000Z",
    }));
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(true);
  });

  it("preserves connector poll status when only enabled changes", async () => {
    const { db } = makeDb({
      "product:product_1": { id: "product_1" },
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://old.example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: "2026-05-19T01:00:00.000Z",
        last_status: "ok",
        last_error: null,
        last_inserted: 3,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_1", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      enabled: false,
      last_polled_at: "2026-05-19T01:00:00.000Z",
      last_status: "ok",
      last_inserted: 3,
    }));
  });

  it.each([
    { page: "abc" },
    { page: 0 },
  ])("rejects invalid scheduled connector page config %#", async (pageConfig) => {
    const { db, statements } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "g2",
        config: { product_slug: "ventora", ...pageConfig },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "page must be a positive integer" });
    expect(statements.some((stmt) => stmt.sql.includes("INSERT INTO connector_configs"))).toBe(false);
  });

  it("accepts valid scheduled connector page config", async () => {
    const { db } = makeDb({
      "product:product_1": { id: "product_1" },
    });

    const response = await reviewsRouter.request("/connector-configs", {
      method: "POST",
      body: JSON.stringify({
        product_id: "product_1",
        source: "g2",
        config: { product_slug: "ventora", page: "2" },
        enabled: true,
      }),
      headers: { "content-type": "application/json" },
    }, { DB: db });

    expect(response.status).toBe(201);
  });

  it("deletes connector configs", async () => {
    const { db, statements } = makeDb({
      "config:cfg_1": {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_1", {
      method: "DELETE",
    }, { DB: db });

    expect(response.status).toBe(204);
    expect(statements.at(-1)?.sql).toBe("DELETE FROM connector_configs WHERE id = ?");
  });

  it("rejects disabled test runs before fetching remote reviews", async () => {
    const { db } = makeDb({
      "config:cfg_disabled": {
        id: "cfg_disabled",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 0,
        last_polled_at: null,
        last_status: null,
        last_error: null,
        last_inserted: null,
        created_at: "2026-05-19T00:00:00.000Z",
      },
    });

    const response = await reviewsRouter.request("/connector-configs/cfg_disabled/test-run", {
      method: "POST",
    }, { DB: db });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "connector config is disabled" });
  });
});

describe("admin review connector config UI", () => {
  it("exposes scheduled connector management actions on the Reviews page", () => {
    const source = readFileSync("admin/src/pages/Reviews.tsx", "utf8");

    expect(source).toContain("function ConnectorConfigPanel");
    expect(source).toContain('api.get<ConnectorConfigListResponse>("reviews/connector-configs")');
    expect(source).toContain('api.post<ConnectorConfig>("reviews/connector-configs"');
    expect(source).toContain('api.post<ConnectorTestRunResult>(`reviews/connector-configs/${id}/test-run`');
    expect(source).toContain("<ConnectorConfigPanel products={products} onSuccess={handleImportSuccess} />");
  });
});
