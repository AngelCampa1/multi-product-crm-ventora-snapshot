import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import settingsRouter from "../../src/routes/admin/settings";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeSettingsDb() {
  const statements: BoundStatement[] = [];
  const product = {
    id: "product_1",
    slug: "grantpipe",
    name: "GrantPipe",
    brand_color: "#2563eb",
    primary_domain: "grantpipe.com",
    widget_public_key: "wk_product1",
    origin_allowlist_json: "[\"https://grantpipe.com\"]",
    firewall_group: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };

  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        sql,
        bindings: [],
        bind: vi.fn(function bind(this: BoundStatement, ...values: unknown[]) {
          this.bindings = values;
          return this;
        }),
        first: vi.fn(async () => product),
        all: vi.fn(async () => ({ results: [product] })),
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

async function patchProduct(body: unknown) {
  const { db, statements } = makeSettingsDb();
  const response = await settingsRouter.request("/products/product_1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { DB: db });
  return { response, statements };
}

describe("admin product settings validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects valid JSON bodies that are not objects", async () => {
    const { response, statements } = await patchProduct(null);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "settings patch body must be a JSON object" });
    expect(statements.some((stmt) => stmt.sql.startsWith("UPDATE products SET"))).toBe(false);
  });

  it("rejects malformed origin allowlist entries before updating products", async () => {
    const { response, statements } = await patchProduct({
      origin_allowlist_json: "[\"not an origin\"]",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "origin_allowlist_json entries must be absolute URL origins",
    });
    expect(statements.some((stmt) => stmt.sql.startsWith("UPDATE products SET"))).toBe(false);
  });

  it("rejects unsafe brand colors before updating products", async () => {
    const { response, statements } = await patchProduct({
      brand_color: "javascript:alert(1)",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "brand_color must be a hex color like #2563eb",
    });
    expect(statements.some((stmt) => stmt.sql.startsWith("UPDATE products SET"))).toBe(false);
  });

  it("rejects primary domains that are not hostnames", async () => {
    const { response, statements } = await patchProduct({
      primary_domain: "https://grantpipe.com/path",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "primary_domain must be a hostname without protocol or path",
    });
    expect(statements.some((stmt) => stmt.sql.startsWith("UPDATE products SET"))).toBe(false);
  });

  it("normalizes valid settings before updating products", async () => {
    vi.stubGlobal("caches", {
      default: {
        delete: vi.fn(async () => true),
      },
    });
    const { response, statements } = await patchProduct({
      brand_color: "#ABCDEF",
      primary_domain: "WWW.GrantPipe.COM",
      origin_allowlist_json: "[\"https://grantpipe.com\",\"https://www.grantpipe.com\"]",
    });

    expect(response.status).toBe(200);
    const update = statements.find((stmt) => stmt.sql.startsWith("UPDATE products SET"));
    expect(update?.bindings).toEqual([
      "#abcdef",
      "www.grantpipe.com",
      "[\"https://grantpipe.com\",\"https://www.grantpipe.com\"]",
      "product_1",
    ]);
  });

  it("keeps the admin UI primary domain hint aligned to backend hostname validation", () => {
    const source = readFileSync("admin/src/pages/Settings.tsx", "utf8");

    expect(source).toContain('placeholder="example.com"');
    expect(source).not.toContain('placeholder="https://example.com"');
  });
});
