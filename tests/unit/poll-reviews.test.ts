import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollReviewConnectors } from "../../src/cron/poll-reviews";
import worker, { type Env } from "../../src/worker";

interface ConnectorConfigFixture {
  id: string;
  product_id: string;
  source: string;
  config_json: string;
  enabled: number;
}

interface BoundStatement extends D1PreparedStatement {
  sql: string;
  bindings: unknown[];
}

const rssXml = `<?xml version="1.0"?>
<rss><channel><item><title>Launch comment</title><guid>ph-1</guid><description>Useful public feedback.</description></item></channel></rss>`;

function makeDb(configs: ConnectorConfigFixture[], opts: {
  existing?: Record<string, unknown>;
  failExternalIds?: string[];
} = {}) {
  const statusWrites: unknown[][] = [];
  const reviewInserts: unknown[][] = [];
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
        all: vi.fn(async function all(this: BoundStatement) {
          if (this.sql.includes("FROM connector_configs WHERE enabled = 1")) {
            return { results: configs.filter((config) => config.enabled === 1) };
          }
          return { results: [] };
        }),
        first: vi.fn(async function first(this: BoundStatement) {
          if (this.sql.includes("FROM reviews WHERE product_id = ? AND source = ? AND external_id = ?")) {
            return opts.existing?.[`${String(this.bindings[0])}:${String(this.bindings[1])}:${String(this.bindings[2])}`] ?? null;
          }
          return null;
        }),
        raw: vi.fn(),
        run: vi.fn(async function run(this: BoundStatement) {
          if (this.sql.includes("INSERT OR IGNORE INTO reviews")) {
            const externalId = String(this.bindings[4]);
            if (opts.failExternalIds?.includes(externalId)) {
              throw new Error("D1 insert failed");
            }
            reviewInserts.push(this.bindings);
          }
          if (this.sql.includes("UPDATE reviews SET")) {
            const externalId = String(this.bindings[8]);
            if (opts.failExternalIds?.includes(externalId)) {
              throw new Error("D1 insert failed");
            }
          }
          if (this.sql.includes("UPDATE connector_configs SET last_polled_at")) {
            statusWrites.push(this.bindings);
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

  return { db, statements, statusWrites, reviewInserts };
}

describe("pollReviewConnectors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls enabled RSS configs with feed-backed source attribution and records ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/product-hunt.xml\",\"review_source\":\"product_hunt\"}",
        enabled: 1,
      },
      {
        id: "cfg_disabled",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/disabled.xml\"}",
        enabled: 0,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(reviewInserts).toHaveLength(1);
    expect(reviewInserts[0]?.[3]).toBe("product_hunt");
    expect(statusWrites).toEqual([
      [expect.any(String), "ok", null, 1, "cfg_1"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records invalid config_json without aborting later configs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "bad_json",
        product_id: "product_1",
        source: "rss",
        config_json: "{",
        enabled: 1,
      },
      {
        id: "cfg_2",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(reviewInserts).toHaveLength(1);
    expect(statusWrites[0]).toEqual([expect.any(String), "error", expect.stringContaining("invalid config_json"), 0, "bad_json"]);
    expect(statusWrites[1]).toEqual([expect.any(String), "ok", null, 1, "cfg_2"]);
  });

  it("records unknown source status and continues", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "unknown",
        product_id: "product_1",
        source: "unknown",
        config_json: "{}",
        enabled: 1,
      },
      {
        id: "cfg_2",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(reviewInserts).toHaveLength(1);
    expect(statusWrites[0]).toEqual([expect.any(String), "error", "unknown source: unknown", 0, "unknown"]);
    expect(statusWrites[1]).toEqual([expect.any(String), "ok", null, 1, "cfg_2"]);
  });

  it("records fetch failures and continues to the next config", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(
      new Response(url.includes("bad") ? "nope" : rssXml, { status: url.includes("bad") ? 500 : 200 }),
    )));
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "bad_fetch",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/bad.xml\"}",
        enabled: 1,
      },
      {
        id: "cfg_2",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(reviewInserts).toHaveLength(1);
    expect(statusWrites[0]).toEqual([expect.any(String), "error", expect.stringContaining("rss connector: HTTP 500"), 0, "bad_fetch"]);
    expect(statusWrites[1]).toEqual([expect.any(String), "ok", null, 1, "cfg_2"]);
  });

  it("records semantically invalid scheduled connector config without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "bad_page",
        product_id: "product_1",
        source: "g2",
        config_json: "{\"product_slug\":\"example-product\",\"page\":\"abc\"}",
        enabled: 1,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(reviewInserts).toHaveLength(0);
    expect(statusWrites).toEqual([
      [expect.any(String), "error", "page must be a positive integer", 0, "bad_page"],
    ]);
  });

  it("records partial save errors with inserted count", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rssXml, { status: 200 })));
    const { db, statusWrites } = makeDb([
      {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
    ], { failExternalIds: ["ph-1"] });

    await pollReviewConnectors({ DB: db } as Env);

    expect(statusWrites).toEqual([
      [expect.any(String), "error", expect.stringContaining("rss:ph-1: D1 insert failed"), 0, "cfg_1"],
    ]);
  });

  it("stores the same external review id separately for different product configs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));
    const { db, statusWrites, reviewInserts } = makeDb([
      {
        id: "cfg_1",
        product_id: "product_1",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
      {
        id: "cfg_2",
        product_id: "product_2",
        source: "rss",
        config_json: "{\"feed_url\":\"https://example.com/feed.xml\"}",
        enabled: 1,
      },
    ]);

    await pollReviewConnectors({ DB: db } as Env);

    expect(reviewInserts).toHaveLength(2);
    expect(reviewInserts.map((bindings) => [bindings[2], bindings[4]])).toEqual([
      ["product_1", "ph-1"],
      ["product_2", "ph-1"],
    ]);
    expect(statusWrites).toEqual([
      [expect.any(String), "ok", null, 1, "cfg_1"],
      [expect.any(String), "ok", null, 1, "cfg_2"],
    ]);
  });
});

describe("worker scheduled handler", () => {
  it("delegates connector polling to ctx.waitUntil", async () => {
    const waitUntil = vi.fn();

    await worker.scheduled?.({} as ScheduledController, { DB: makeDb([]).db } as Env, {
      waitUntil,
    } as unknown as ExecutionContext);

    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
