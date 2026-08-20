import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRSS, rssConnector } from "../../src/connectors/rss";

const rssXml = `<?xml version="1.0"?>
<rss>
  <channel>
    <item>
      <title>Great app</title>
      <link>https://example.com/reviews/1</link>
      <guid>review-1</guid>
      <description>Useful real customer review.</description>
      <author>Jane Doe</author>
    </item>
  </channel>
</rss>`;

describe("RSS feed-backed review sources", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults generic feeds to rss source", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));

    await expect(fetchRSS("https://example.com/feed.xml")).resolves.toEqual([
      expect.objectContaining({
        external_id: "review-1",
        source: "rss",
      }),
    ]);
  });

  it("preserves App Store and Product Hunt source attribution for feed-backed imports", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(rssXml, { status: 200 }))));

    await expect(fetchRSS("https://example.com/app-store.xml", "app_store")).resolves.toEqual([
      expect.objectContaining({ source: "app_store" }),
    ]);
    await expect(fetchRSS("https://example.com/product-hunt.xml", "product_hunt")).resolves.toEqual([
      expect.objectContaining({ source: "product_hunt" }),
    ]);
  });

  it("rejects unsupported feed-backed source values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rssXml, { status: 200 })));

    await expect(fetchRSS("https://example.com/feed.xml", "g2")).rejects.toThrow(
      "rss connector: review_source must be one of: rss, app_store, product_hunt",
    );
  });

  it("uses review_source from scheduled connector config", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(rssXml, { status: 200 })));

    await expect(rssConnector.fetch({
      feed_url: "https://example.com/product-hunt.xml",
      review_source: "product_hunt",
    })).resolves.toEqual([
      expect.objectContaining({ source: "product_hunt" }),
    ]);
  });

  it("uses body content in fallback ids for body-only feed items", async () => {
    const bodyOnlyFeed = `<?xml version="1.0"?>
<rss><channel>
  <item><description>First body-only review.</description></item>
  <item><description>Second body-only review.</description></item>
</channel></rss>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bodyOnlyFeed, { status: 200 })));

    const results = await fetchRSS("https://example.com/feed.xml");

    expect(results).toHaveLength(2);
    expect(results[0]?.external_id).not.toBe(results[1]?.external_id);
  });

  it("rejects oversized RSS responses before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", {
      status: 200,
      headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
    })));

    await expect(fetchRSS("https://example.com/feed.xml")).rejects.toThrow(
      "rss connector: response exceeds 2097152 byte limit",
    );
  });
});
