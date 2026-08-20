import { afterEach, describe, expect, it, vi } from "vitest";
import { g2ScrapeConnector, scrapeG2 } from "../../src/connectors/scrape-g2";
import { scrapeTrustpilot, trustpilotScrapeConnector } from "../../src/connectors/scrape-trustpilot";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scrapeG2", () => {
  it("throws on HTTP non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("blocked", { status: 403 })),
    );

    await expect(scrapeG2("example-product")).rejects.toThrow(
      "scrape-g2: HTTP 403",
    );
  });

  it("throws on fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await expect(scrapeG2("example-product")).rejects.toThrow(
      "scrape-g2: fetch failed",
    );
  });

  it("returns an empty array when a successful page has no parseable reviews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body>No reviews here</body></html>", {
          status: 200,
        }),
      ),
    );

    await expect(scrapeG2("example-product")).resolves.toEqual([]);
  });

  it("rejects oversized successful pages before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x", {
          status: 200,
          headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
        }),
      ),
    );

    await expect(scrapeG2("example-product")).rejects.toThrow(
      "scrape-g2: response exceeds 2097152 byte limit",
    );
  });

  it("uses canonical JSON-LD review URLs for stable external IDs and source URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Review",
            url: "https://www.g2.com/products/example-product/reviews/review-123",
            author: { name: "Jane Doe" },
            reviewBody: "Original public review body.",
            reviewRating: { ratingValue: 5 },
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const first = await scrapeG2("example-product");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Review",
            url: "https://www.g2.com/products/example-product/reviews/review-123",
            author: { name: "Jane Doe" },
            reviewBody: "Edited public review body.",
            reviewRating: { ratingValue: 4 },
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const second = await scrapeG2("example-product");

    expect(first[0]).toEqual(expect.objectContaining({
      source_url: "https://www.g2.com/products/example-product/reviews/review-123",
    }));
    expect(second[0]?.external_id).toBe(first[0]?.external_id);
  });

  it("extracts reviews nested in JSON-LD @graph blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Product",
                name: "Example Product",
                review: [
                  {
                    "@type": "Review",
                    url: "/products/example-product/reviews/review-graph",
                    author: { name: "Graph Author" },
                    reviewBody: "Nested graph review body.",
                    reviewRating: { ratingValue: "4.5" },
                  },
                ],
              },
            ],
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const reviews = await scrapeG2("example-product");

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(expect.objectContaining({
      author_name: "Graph Author",
      body: "Nested graph review body.",
      rating: 4.5,
      source_url: "https://www.g2.com/products/example-product/reviews/review-graph",
    }));
  });

  it("normalizes invalid connector page config instead of fetching page=NaN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body>No reviews here</body></html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await g2ScrapeConnector.fetch({ product_slug: "example-product", page: "abc" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page=1");
  });
});

describe("scrapeTrustpilot", () => {
  it("throws on HTTP non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("blocked", { status: 429 })),
    );

    await expect(scrapeTrustpilot("example.com")).rejects.toThrow(
      "scrape-trustpilot: HTTP 429",
    );
  });

  it("throws on fetch failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ETIMEDOUT")));

    await expect(scrapeTrustpilot("example.com")).rejects.toThrow(
      "scrape-trustpilot: fetch failed",
    );
  });

  it("returns an empty array when a successful page has no parseable reviews", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body>No reviews here</body></html>", {
          status: 200,
        }),
      ),
    );

    await expect(scrapeTrustpilot("example.com")).resolves.toEqual([]);
  });

  it("rejects oversized successful pages before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x", {
          status: 200,
          headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
        }),
      ),
    );

    await expect(scrapeTrustpilot("example.com")).rejects.toThrow(
      "scrape-trustpilot: response exceeds 2097152 byte limit",
    );
  });

  it("uses canonical JSON-LD review URLs for stable external IDs and source URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Organization",
            review: [
              {
                url: "https://www.trustpilot.com/reviews/abc123",
                author: { name: "Sam Lee" },
                reviewBody: "Original public review body.",
                reviewRating: { ratingValue: 5 },
              },
            ],
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const first = await scrapeTrustpilot("example.com");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Organization",
            review: [
              {
                url: "https://www.trustpilot.com/reviews/abc123",
                author: { name: "Sam Lee" },
                reviewBody: "Edited public review body.",
                reviewRating: { ratingValue: 4 },
              },
            ],
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const second = await scrapeTrustpilot("example.com");

    expect(first[0]).toEqual(expect.objectContaining({
      source_url: "https://www.trustpilot.com/reviews/abc123",
    }));
    expect(second[0]?.external_id).toBe(first[0]?.external_id);
  });

  it("extracts reviews nested in JSON-LD @graph blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<script type="application/ld+json">${JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Organization",
                review: [
                  {
                    "@type": "Review",
                    url: "/reviews/graph123",
                    author: { name: "Trust Graph" },
                    reviewBody: "Trustpilot graph review body.",
                    reviewRating: { ratingValue: "4" },
                  },
                ],
              },
            ],
          })}</script>`,
          { status: 200 },
        ),
      ),
    );

    const reviews = await scrapeTrustpilot("example.com");

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(expect.objectContaining({
      author_name: "Trust Graph",
      body: "Trustpilot graph review body.",
      rating: 4,
      source_url: "https://www.trustpilot.com/reviews/graph123",
    }));
  });

  it("normalizes invalid connector page config instead of fetching page=NaN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body>No reviews here</body></html>", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await trustpilotScrapeConnector.fetch({ business_unit_id: "example.com", page: "abc" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("page=1");
  });
});
