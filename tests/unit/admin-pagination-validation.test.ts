import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../src/worker";

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

function makeEnv() {
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
        first: vi.fn(async () => ({ total: 0, n: 0 })),
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

  const env: Env = {
    DEV_AUTH_BYPASS: "true",
    DB: db,
    MEDIA: {
      delete: vi.fn(),
    } as unknown as Env["MEDIA"],
    ASSETS: {
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
    } as unknown as Fetcher,
  };

  return { env, statements };
}

describe("admin list pagination validation", () => {
  it("clamps customer list pagination before querying D1", async () => {
    const { env, statements } = makeEnv();

    const response = await worker.fetch(
      new Request("http://127.0.0.1:8787/api/admin/customers?limit=-1&offset=-20"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const listStatement = statements.find((stmt) => stmt.sql.includes("FROM customers") && stmt.sql.includes("LIMIT ? OFFSET ?"));
    expect(listStatement?.bindings.slice(-2)).toEqual([50, 0]);
  });

  it("clamps testimonial list pagination before querying D1", async () => {
    const { env, statements } = makeEnv();

    const response = await worker.fetch(
      new Request("http://127.0.0.1:8787/api/admin/testimonials?limit=-1&offset=-20"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const listStatement = statements.find((stmt) => stmt.sql.includes("FROM testimonials t") && stmt.sql.includes("LIMIT ? OFFSET ?"));
    expect(listStatement?.bindings.slice(-2)).toEqual([50, 0]);
  });
});
