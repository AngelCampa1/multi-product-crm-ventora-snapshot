import { nowIso } from "../db/queries";
import { readResponseTextBounded, sha256Hex } from "./base";
import type { Connector, ConnectorResult } from "./base";
import type { Review } from "../db/queries";

const FEED_REVIEW_SOURCES = ["rss", "app_store", "product_hunt"] as const satisfies readonly Review["source"][];
export type FeedReviewSource = (typeof FEED_REVIEW_SOURCES)[number];

export function parseFeedReviewSource(value: unknown): FeedReviewSource | null {
  if (value === undefined || value === null || value === "") return "rss";
  return typeof value === "string" && (FEED_REVIEW_SOURCES as readonly string[]).includes(value)
    ? value as FeedReviewSource
    : null;
}

export function feedReviewSourceError(): string {
  return `review_source must be one of: ${FEED_REVIEW_SOURCES.join(", ")}`;
}

// ---------------------------------------------------------------------------
// RSS/Atom parser — regex-based, no DOMParser (not available in workerd).
// Handles RSS 2.0 and Atom 1.0.
// ---------------------------------------------------------------------------

function extractTag(block: string, tag: string): string {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`,
    "i",
  );
  return block.match(re)?.[1]?.trim() ?? "";
}

function extractAttr(block: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
  return block.match(re)?.[1]?.trim() ?? "";
}

export async function fetchRSS(feedUrl: string, reviewSourceInput: unknown = "rss"): Promise<ConnectorResult[]> {
  const reviewSource = parseFeedReviewSource(reviewSourceInput);
  if (!reviewSource) {
    throw new Error(`rss connector: ${feedReviewSourceError()}`);
  }

  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; VentoraCRM/1.0; +https://ventora.app) RSS reader",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
  });

  if (!res.ok) {
    throw new Error(`rss connector: HTTP ${res.status} fetching ${feedUrl}`);
  }

  const xml = await readResponseTextBounded(res, "rss connector");
  const isAtom = /<feed[\s>]/i.test(xml);

  const itemTag = isAtom ? "entry" : "item";
  const itemRe = new RegExp(`<${itemTag}[\\s>][\\s\\S]*?</${itemTag}>`, "gi");
  const items = xml.match(itemRe) ?? [];

  const now = nowIso();
  const results: ConnectorResult[] = [];

  for (const item of items) {
    const title = extractTag(item, "title");

    const link = isAtom
      ? extractAttr(item, "link", "href") || extractTag(item, "link")
      : extractTag(item, "link");

    const body =
      extractTag(item, "content:encoded") ||
      extractTag(item, "content") ||
      extractTag(item, "description") ||
      extractTag(item, "summary") ||
      title;

    if (!body) continue;

    const author_name =
      extractTag(item, "name") ||
      extractTag(item, "author") ||
      extractTag(item, "dc:creator") ||
      null;

    const guidText =
      extractTag(item, "guid") || extractTag(item, "id");

    const publishedAt =
      extractTag(item, "pubDate") ||
      extractTag(item, "published") ||
      extractTag(item, "updated");

    const external_id = guidText
      ? guidText
      : await sha256Hex([
        title.trim(),
        link.trim(),
        body.trim().replace(/\s+/g, " "),
        author_name?.trim() ?? "",
        publishedAt.trim(),
      ].join("|"));

    results.push({
      external_id,
      source: reviewSource,
      author_name: author_name || null,
      body,
      rating: null,
      source_url: link || null,
      imported_at: now,
    });
  }

  return results;
}

export const rssConnector: Connector = {
  source: "rss",

  async fetch(config: Record<string, string>): Promise<ConnectorResult[]> {
    const { feed_url, review_source } = config;
    if (!feed_url) {
      throw new Error("rss connector: 'feed_url' is required");
    }
    return fetchRSS(feed_url, review_source);
  },
};
